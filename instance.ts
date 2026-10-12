import type {InstancePluginContext} from '@clusterio/host';
import {ChatEvent} from './index.js';

interface ChatMessage {
    datetime: string;
	message: string;
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
        if (output.type !== 'action') {
            return;
        }

        const now = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const dt = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
        const action = output.action;
        let message = output.message.trim();

        if (action === 'CHAT' || action === 'SHOUT') {
            message = message.replace(/\[special-item=.*?\]/g, '<blueprint>').replace(/<@/g, '<@\u200c>');
            const message_index = message.indexOf(':');
            const message_username = message_index === -1 ? message : message.slice(0, message_index);
            const message_content = message_index === -1 ? '' : message.slice(message_index + 1).trim();

            queue.push({datetime: dt, message: `**\`${message_username}\`**: ${message_content}`});
        } else {
            const message_index = message.indexOf(' ');
            const message_username = message_index === -1 ? message : message.slice(0, message_index);
            const message_content = message_index === -1 ? '' : message.slice(message_index + 1).trim();
            const player_count = instance.playersOnline.size + (action === 'JOIN' ? 0 : -1);

            queue.push({datetime: dt, message: `**\`${message_username}\`** ${message_content} (${player_count})`});
        }

        await flush();
    });
}
