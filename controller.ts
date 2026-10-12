import type {ControllerPluginContext} from '@clusterio/controller';
import {REST, Routes} from 'discord.js';
import {ChatEvent} from './index.js';

/* Controller-side half of the chat relay: Factorio chat -> Discord.
 * One-way only, so this talks to the REST API directly instead of opening a
 * gateway Client: no intents (and no privileged MessageContent verification),
 * no login/destroy lifecycle, no reconnect state machine.
*/

// Discord's hard limit is 2000; keep headroom for future decoration.
const MAX_MESSAGE_LENGTH = 1950;

// Only break on a word boundary if it gets us at least this far into the window.
const MIN_WORD_BREAK_FILL = 0.5;

const ERROR_UNKNOWN_CHANNEL = 10003;

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

    // Array.from, not slice, so we never cut an emoji's surrogate pair in half.
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

export default async function(context: ControllerPluginContext) {
    const {controller, logger, plugin} = context;

    let rest: REST | null = null;
    let shuttingDown = false;

    // Log-once guards. A channel that is unmapped or unusable gets hit once per chat
    // line, which is how a typo in the config turns into a 10k-line log file.
    const warnedNoMapping = new Set<string>();
    const warnedBadChannel = new Set<string>();

    // Serialise reconnects so two quick config changes can't interleave and have
    // the older attempt null out the newer client.
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => {});
        return run;
    };

    const connect = async () => {
        rest = null;

        const token = controller.config.get('chat_relay.discord_bot_token') as string | undefined;
        if (!token) {
            logger.error('[Chat Relay] Discord bot token not configured.');
            return;
        }

        const client = new REST({version: '10'}).setToken(token);

        try {
            // Fails fast at startup instead of silently on the first chat line.
            const me = await client.get(Routes.user('@me')) as {id: string, username: string};
            logger.info(`[Chat Relay] Authenticated with Discord as ${me.username} (${me.id}).`);
        } catch (err) {
            logger.error(`[Chat Relay] Discord token rejected:\n${stackOf(err)}`);
            return;
        }

        rest = client;
    };

    const getChannelId = (instanceName: string): string | null => {
        const mapping = controller.config.get('chat_relay.discord_channel_mapping') as Record<string, string> | undefined;
        const channelId = mapping?.[instanceName];

        if (!channelId) {
            if (!warnedNoMapping.has(instanceName)) {
                warnedNoMapping.add(instanceName);
                logger.warn(`[Chat Relay] No Discord channel mapped for instance ${instanceName}; dropping its messages.`);
            }

            return null;
        }

        return channelId;
    };

    const sendMessage = async (instanceName: string, datetime: string, message: string) => {
        if (shuttingDown) return;

        const discord = rest;
        // Not configured, or the token was rejected. connect() already logged.
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
        }
    });

    controller.hooks.shutdown.attach(plugin.name, async () => {
        // Nothing to tear down without a gateway; just stop accepting new sends.
        // In-flight REST calls aren't cancellable and will finish or time out.
        shuttingDown = true;
    });

    await connect();
}
