import type {InstancePluginContext} from '@clusterio/host';
import {ChatEvent} from './index.js';

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

function parse_save(line: string): {name: string, slot?: number} | null {
    const m = SAVE_LINE_RE.exec(line);
    if (!m) return null;

    const slot = AUTOSAVE_NAME_RE.exec(m[1]);
    return {name: m[1], slot: slot ? Number(slot[1]) : undefined};
}

export default async function(context: InstancePluginContext) {
    const {instance, host, plugin, logger} = context;
    const queue: ChatMessage[] = [];
    let flushing = false;

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
        } else if (output.type === 'info') {
            let message = output.message.trim();
            const save_slot = parse_save(message);

            if (!save_slot) {
                return;
            }

            const dt = datetime();
            queue.push({datetime: dt, message: `**AUTO SAVE SLOT ${save_slot}**`});
            await flush();
        }
    });
}
