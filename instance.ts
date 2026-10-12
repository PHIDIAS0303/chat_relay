import type {InstancePluginContext} from '@clusterio/host';
import {ChatEvent} from './index.js';

interface ChatMessage {
    action: string;
    content: string;
}

const ACTION_VERBS: Record<string, string> = {
    JOIN: 'joined the game',
    LEAVE: 'left the game',
    KICK: 'was kicked from the game',
    BAN: 'was banned from the game',
};

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
        if (output.type !== 'action') {
            return;
        }

        const now = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const dt = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

        if (output.action === 'CHAT' || output.action === 'SHOUT') {
            const message = output.message.trim().replace(/\[special-item=.*?\]/g, '<blueprint>').replace(/<@/g, '<@\u200c>');
            const message_index = message.indexOf(':');
            const message_username = message_index === -1 ? message.trim() : message.slice(0, message_index);
            const message_content = index === -1 ? '' : message.slice(index + 1).trim();

            queue.push({datetime: dt, message: `**\`${message_username}\`**: ${message_content}`});
        } else if (ACTION_VERBS[output.action]) {
            const name = text.toLowerCase().endsWith(ACTION_VERBS[output.action])
                ? text.slice(0, -ACTION_VERBS[output.action].length).trim()
                : text;

            queue.push({datetime: dt, message: `**\`${name}\`** ${ACTION_VERBS[output.action]} (${instance.playersOnline.size})`});
        } else {
            queue.push({datetime: dt, message: `unknown action ${output.action}`});
        }

        await flush();
    });
}
