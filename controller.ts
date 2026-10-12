import type {ControllerPluginContext} from '@clusterio/controller';
import {Client, GatewayIntentBits, REST, Routes} from 'discord.js';
import type {Message} from 'discord.js';
import {ChatEvent, ChatFromDiscordEvent} from './index.js';

/* Controller-side halves of the chat relay.
 * Outbound (Factorio -> Discord) talks to the REST API directly: no socket, no intents.
 * Inbound (Discord -> Factorio) needs messageCreate, so it owns a real gateway Client.
 * Both are built from the same token and rebuilt by the same enqueue chain, so a token
 * rotation can't leave one half running on the old credential.
 *
 * Both directions read the single `discord_channel_mapping` field (instance name ->
 * channel ID). The reverse lookup is built by inverting it, so the two directions can
 * never disagree about which channel belongs to which instance.
 */

// Discord's hard limit is 2000; keep headroom for future decoration.
const MAX_MESSAGE_LENGTH = 1950;

// Only break on a word boundary if it gets us at least this far into the window.
const MIN_WORD_BREAK_FILL = 0.5;

const ERROR_UNKNOWN_CHANNEL = 10003;

// Factorio chat scroll is a shared, scarce resource; be stricter than Discord is.
const INBOUND_BUCKET_SIZE = 5;
const INBOUND_REFILL_PER_SEC = 0.5;

interface DiscordError {
    code?: number;
    status?: number;
    message?: string;
    stack?: string;
}

const stackOf = (err: unknown): string => (err as DiscordError)?.stack ?? String(err);
const codeOf = (err: unknown): number | undefined => (err as DiscordError)?.code;

/** Split `text` into chunks of at most `limit` code points, preferring word boundaries. */
function splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) {
        return text.length === 0 ? [] : [text];
    }

    // Array.from, not slice, so we never cut a surrogate pair in half.
    const chars = Array.from(text);
    const chunks: string[] = [];
    let offset = 0;

    while (offset < chars.length) {
        let end = Math.min(offset + limit, chars.length);

        if (end < chars.length) {
            const window = chars.slice(offset, end);
            let newline = -1;
            let space = -1;

            for (let i = window.length - 1; i > 0; i--) {
                if (window[i] === '\n') {
                    newline = i;
                    break;
                }

                if (space === -1 && window[i] === ' ') {
                    space = i;
                }
            }

            const cut = newline > 0 ? newline : space;
            if (cut >= window.length * MIN_WORD_BREAK_FILL) {
                end = offset + cut;
            }
        }

        chunks.push(chars.slice(offset, end).join('').trim());
        offset = end;

        // Skip the whitespace we broke on so it doesn't open the next chunk.
        while (offset < chars.length && /\s/.test(chars[offset])) {
            offset++;
        }
    }

    return chunks.filter(chunk => chunk.length > 0);
}

interface Bucket {
    tokens: number;
    updated: number;
    warned: boolean;
}

/** Config is keyed by instance name; sendTo wants the controller's numeric ID. */
const findInstanceId = (instanceName: string): number | null => {
    for (const [id, instance] of controller.instances) {
        if (instance.name === instanceName) return id;
    }

    return null;
};

export default async function(context: ControllerPluginContext) {
    const {controller, logger, plugin} = context;

    let rest: REST | null = null;
    let client: Client | null = null;
    let shuttingDown = false;

    // Log-once guards. A channel that is unmapped or unusable gets hit once per chat
    // line, which is how a typo in the config turns into a 10k-line log file.
    const warnedNoMapping = new Set<string>();
    const warnedBadChannel = new Set<string>();
    const warnedAmbiguous = new Set<string>();
    const warnedNoInstance = new Set<string>();
    const warnedSendFail = new Set<string>();

    // Inverted view of discord_channel_mapping, rebuilt rather than mutated in place.
    let channelToInstances = new Map<string, string[]>();
    const buckets = new Map<string, Bucket>();

    // Serialise reconnects so two quick config changes can't interleave and have
    // the older attempt null out the newer client.
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => {});
        return run;
    };

    const getToken = () => controller.config.get('chat_relay.discord_bot_token') as string | undefined;

    // --------------------------------------------------------------- outbound

    const getChannelId = (instanceName: string): string | null => {
        const mapping = controller.config.get('chat_relay.discord_channel_mapping') as
            Record<string, string> | undefined;
        const channelId = mapping?.[instanceName];

        if (!channelId) {
            if (!warnedNoMapping.has(instanceName)) {
                warnedNoMapping.add(instanceName);
                logger.warn(
                    `[Chat Relay] No Discord channel mapped for instance ${instanceName};`
                    + ' dropping its messages.',
                );
            }

            return null;
        }

        return channelId;
    };

    const sendMessage = async (instanceName: string, datetime: string, message: string) => {
        if (shuttingDown) return;

        const discord = rest;
        // Not configured, or the token was rejected. connect() already logged it.
        if (!discord) return;

        const channelId = getChannelId(instanceName);
        if (!channelId) return;

        // Read the flag once, so it can't flip between chunks of one message.
        let content = message;
        if (controller.config.get('chat_relay.datetime_on_message')) {
            content = `${datetime} ${content}`;
        }

        // trim() here also means an empty chat line produces zero chunks rather than
        // a 50006 'cannot send an empty message' from Discord.
        const chunks = splitMessage(content.trim(), MAX_MESSAGE_LENGTH);

        for (const chunk of chunks) {
            try {
                // discord.js REST handles rate limits (429) and retries for us.
                await discord.post(Routes.channelMessages(channelId), {
                    body: {content: chunk, allowedMentions: {parse: []}},
                });
            } catch (err) {
                if (codeOf(err) === ERROR_UNKNOWN_CHANNEL) {
                    if (!warnedBadChannel.has(channelId)) {
                        warnedBadChannel.add(channelId);
                        logger.warn(
                            `[Chat Relay] Discord channel ${channelId} does not exist or is not visible`
                            + ` to the bot; dropping messages for ${instanceName}.`,
                        );
                    }
                } else {
                    logger.error(`[Chat Relay] Discord send failed for ${instanceName}:\n${stackOf(err)}`);
                }

                // Don't keep hammering a channel that just rejected us.
                return;
            }
        }
    };

    // ---------------------------------------------------------------- inbound

    const rebuildInboundMap = () => {
        const mapping = controller.config.get('chat_relay.discord_channel_mapping') as
            Record<string, string> | undefined;

        const next = new Map<string, string[]>();

        for (const [instanceName, channelId] of Object.entries(mapping ?? {})) {
            // A blank value would otherwise map the literal channel ''.
            if (!channelId) continue;

            const names = next.get(channelId) ?? [];
            names.push(instanceName);
            next.set(channelId, names);
        }

        for (const [channelId, names] of next) {
            if (names.length > 1 && !warnedAmbiguous.has(channelId)) {
                warnedAmbiguous.add(channelId);
                logger.warn(
                    `[Chat Relay] Discord channel ${channelId} is mapped by ${names.length} instances`
                    + ` (${names.join(', ')}); its messages are printed in all of them.`,
                );
            }
        }

        channelToInstances = next;
    };

    const hasInboundMapping = () => channelToInstances.size > 0;

    /** Token bucket per channel: Discord is far chattier than Factorio chat ever is. */
    const takeToken = (channelId: string): boolean => {
        const now = Date.now();
        let bucket = buckets.get(channelId);

        if (!bucket) {
            bucket = {tokens: INBOUND_BUCKET_SIZE, updated: now, warned: false};
            buckets.set(channelId, bucket);
        }

        bucket.tokens = Math.min(
            INBOUND_BUCKET_SIZE,
            bucket.tokens + ((now - bucket.updated) / 1000) * INBOUND_REFILL_PER_SEC,
        );
        bucket.updated = now;

        // Re-arm the warning once the channel has calmed down.
        if (bucket.tokens >= INBOUND_BUCKET_SIZE) bucket.warned = false;

        if (bucket.tokens < 1) {
            if (!bucket.warned) {
                bucket.warned = true;
                logger.warn(`[Chat Relay] Rate limiting inbound chat from channel ${channelId}; dropping.`);
            }

            return false;
        }

        bucket.tokens -= 1;
        return true;
    };

    const onDiscordMessage = async (message: Message) => {
        if (shuttingDown) return;

        // The loop guard. Our own outbound posts are authored by the bot, as are
        // webhooks and other bots, so Factorio -> Discord -> Factorio dies here.
        if (message.author.bot) return;

        // DMs, group DMs and other unmapped guilds have no instance behind them.
        if (!message.inGuild()) return;

        const instanceNames = channelToInstances.get(message.channelId);
        if (!instanceNames) return;

        if (!message.content) return;
        if (!takeToken(message.channelId)) return;

        const datetime = message.createdAt.toISOString();
        const authorName = message.member?.displayName ?? message.author.username;

        for (const instanceName of instanceNames) {
            const instanceId = findInstanceId(instanceName);

            if (instanceId === null) {
                if (!warnedNoInstance.has(instanceName)) {
                    warnedNoInstance.add(instanceName);
                    logger.warn(
                        `[Chat Relay] Instance ${instanceName} is mapped for chat but does not exist;`
                        + ' dropping Discord messages for it.',
                    );
                }

                continue;
            }

            try {
                await controller.sendTo({instanceId: instanceId}, new ChatFromDiscordEvent(
                    authorName,
                    message.channelId,
                    datetime,
                    message.content,
                ));
            } catch (err) {
                // A stopped instance on a busy channel would otherwise be a log flood.
                if (!warnedSendFail.has(instanceName)) {
                    warnedSendFail.add(instanceName);
                    logger.error(
                        `[Chat Relay] Failed to relay Discord chat to ${instanceName}:\n${stackOf(err)}`,
                    );
                }
            }
        }
    };

    // ----------------------------------------------------------------- client

    const closeGateway = async () => {
        const old = client;
        client = null;

        if (old) {
            try {
                await old.destroy();
            } catch (err) {
                logger.error(`[Chat Relay] Discord gateway shutdown error:\n${stackOf(err)}`);
            }
        }
    };

    /** Requires an authenticated `rest`; only ever called from connect()/syncGateway(). */
    const openGateway = async () => {
        const token = getToken();
        if (!token || !rest || client) return;

        const newClient = new Client({intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ]});

        newClient.on('messageCreate', message => {
            onDiscordMessage(message).catch(err => {
                logger.error(`[Chat Relay] Inbound handler failed:\n${stackOf(err)}`);
            });
        });

        newClient.on('error', err => logger.error(`[Chat Relay] Discord gateway error:\n${stackOf(err)}`));
        newClient.on('shardDisconnect', () => logger.warn('[Chat Relay] Discord gateway disconnected.'));

        try {
            await newClient.login(token);
        } catch (err) {
            // Outbound still works off `rest`; only inbound is down.
            logger.error(`[Chat Relay] Discord gateway login failed (inbound disabled):\n${stackOf(err)}`);
            await newClient.destroy().catch(() => {});
            return;
        }

        if (shuttingDown) {
            await newClient.destroy().catch(() => {});
            return;
        }

        client = newClient;
        logger.info('[Chat Relay] Discord gateway connected; inbound chat enabled.');
    };

    const syncGateway = async () => {
        if (!hasInboundMapping()) {
            await closeGateway();
            return;
        }

        await openGateway();
    };

    const connect = async () => {
        // Drop both halves first: the old REST client holds the previous token, and
        // the old gateway is logged in with it.
        rest = null;
        await closeGateway();

        const token = getToken();
        if (!token) {
            logger.error('[Chat Relay] Discord bot token not configured.');
            return;
        }

        const newRest = new REST({version: '10'}).setToken(token);

        try {
            // Fail fast at startup instead of silently on the first chat line.
            const me = await newRest.get(Routes.user('@me')) as {id: string, username: string};
            logger.info(`[Chat Relay] Authenticated with Discord as ${me.username} (${me.id}).`);
        } catch (err) {
            logger.error(`[Chat Relay] Discord token rejected:\n${stackOf(err)}`);
            return;
        }

        if (shuttingDown) return;

        rest = newRest;
        await syncGateway();
    };

    // ----------------------------------------------------------------- wiring

    rebuildInboundMap();

    controller.handle(ChatEvent, async (request: ChatEvent) => {
        await sendMessage(request.instance_name, request.datetime, request.message);
    });

    controller.config.on('fieldChanged', (field) => {
        if (field === 'chat_relay.discord_bot_token') {
            enqueue(connect).catch(err => {
                logger.error(`[Chat Relay] Discord reconnect failed:\n${stackOf(err)}`);
            });
        } else if (field === 'chat_relay.discord_channel_mapping') {
            warnedNoMapping.clear();
            warnedBadChannel.clear();
            warnedAmbiguous.clear();
            warnedNoInstance.clear();
            warnedSendFail.clear();
            buckets.clear();
            rebuildInboundMap();
            enqueue(syncGateway).catch(err => {
                logger.error(`[Chat Relay] Discord gateway sync failed:\n${stackOf(err)}`);
            });
        }
    });

    controller.hooks.shutdown.attach(plugin.name, async () => {
        // Nothing to tear down on the REST side; in-flight calls aren't cancellable
        // and will finish or time out. The gateway does need an explicit destroy.
        shuttingDown = true;
        await closeGateway();
    });

    await connect();
}
