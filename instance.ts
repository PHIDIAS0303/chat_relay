import type {InstancePluginContext} from '@clusterio/host';
import {ChatEvent, ChatFromDiscordEvent, sanitiseForFactorio} from './index.js';

interface ChatMessage {
    datetime: string;
    message: string;
}

function datetime(): string {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// Message body only. `.+?` (not `\S+`) so a manual save named 'my map' still parses.
const SAVE_LINE_RE = /Saving to (.+?) \((?:non-)?blocking\)\./;

// Factorio's autosaves are literally named '_autosave1'..'_autosaveN'.
const AUTOSAVE_NAME_RE = /^_autosave(\d+)$/;

function parse_save(line: string): number | null {
    const m = SAVE_LINE_RE.exec(line);
    if (!m) return null;
    const slot = AUTOSAVE_NAME_RE.exec(m[1]);
    return slot ? Number(slot[1]) : null;
}

/** Escape a JS string for embedding in a double-quoted Lua literal. */
function luaString(text: string): string {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export default async function(context: InstancePluginContext) {
    const {instance, host, plugin, logger} = context;
    const queue: ChatMessage[] = [];
    let flushing = false;

    // Log-once guard: a busy channel plus a stopped instance or dead RCON would
    // otherwise write one error per message. Re-armed on controller connect.
    const warnedPrintFail = new Set<string>();

    const flush = async () => {
        if (flushing || queue.length === 0 || !host.connector.connected) {
            return;
        }

        flushing = true;

        try {
            while (queue.length > 0 && host.connector.connected) {
                try {
                    await instance.sendTo('controller', new ChatEvent(instance.name, queue[0].datetime, queue[0].message));
                    queue.shift();
                } catch (err) {
                    logger.warn(`[Chat Relay] Failed to send chat to controller: ${err}`);
                    break;
                }
            }
        } finally {
            flushing = false;
        }
    };

    instance.hooks.controllerConnectionEvent.attach(plugin.name, async (event) => {
        if (event === 'connect') {
            warnedPrintFail.clear();
            await flush();
        }
    });

    instance.hooks.output.attach(plugin.name, async (output) => {
        if (output.type === 'action') {
            const dt = datetime();
            const action = output.action;
            let message = output.message.trim();

            if (action === 'CHAT' || action === 'SHOUT') {
                message = message.replace(/\[special-item=.*?\]/g, '<blueprint>').replace(/<@/g, '<@\u200c>');
                const message_index = message.indexOf(':');
                const message_username = message_index === -1 ? message : message.slice(0, message_index);
                const message_content = message_index === -1 ? '' : message.slice(message_index + 1).trim();

                queue.push({datetime: dt, message: `**\`${message_username}\`**: ${message_content}`});
            } else if (action === 'JOIN' || action === 'LEAVE' || action === 'KICK' || action === 'BAN' || action === 'UNBANNED') {
                const message_index = message.indexOf(' ');
                const message_username = message_index === -1 ? message : message.slice(0, message_index);
                const message_content = message_index === -1 ? '' : message.slice(message_index + 1).trim();
                const player_count = instance.playersOnline.size + (action === 'JOIN' ? 0 : -1);

                queue.push({datetime: dt, message: `**\`${message_username}\`** ${message_content} (${player_count})`});
            }

            await flush();
        } else if (output.type === 'log') {
            const message = output.message.trim();
            const save_slot = parse_save(message);

            if (!save_slot) {
                return;
            }

            const dt = datetime();
            queue.push({datetime: dt, message: `**AUTO SAVE SLOT ${save_slot}**`});
            await flush();
        }
    });

    instance.handle(ChatFromDiscordEvent, async (event: ChatFromDiscordEvent) => {
        // Re-sanitise here too: any producer can publish this event, and this is
        // the process that actually calls game.print.
        const author = sanitiseForFactorio(event.author_name, 40);
        const message = sanitiseForFactorio(event.message);
        if (!message) return;

        const line = `[DC] ${author}: ${message}`;

        try {
            // game.print reaches every player and does NOT fire on_console_chat,
            // so this cannot echo back out through the outbound half.
            await instance.sendRcon(`/sc game.print(${luaString(line)})`);
            logger.info(`[Chat Relay] ${line}`);
        } catch (err) {
            if (!warnedPrintFail.has(instance.name)) {
                warnedPrintFail.add(instance.name);
                logger.error(`[Chat Relay] Failed to print Discord message in game:\n${(err as Error).stack}`);
            }
        }
    });
}
