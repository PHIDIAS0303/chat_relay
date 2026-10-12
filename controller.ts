import type {ControllerPluginContext} from '@clusterio/controller';
import {ChatEvent} from './index.js';
import * as Discord from 'discord.js';

const MAX_DISCORD_MESSAGE_LENGTH = 1950;

export default async function(context: ControllerPluginContext) {
    const {controller, logger, plugin} = context;
    let client: Discord.Client | null = null;

    const clientDestroy = async () => {
        if (client) {
            await client.destroy();
        }

        client = null;
    };

    const connect = async () => {
        await clientDestroy();
        const token = controller.config.get('chat_relay.discord_bot_token') as string | undefined;

        if (!token) {
            logger.error('[Chat Relay] Discord bot token not configured.');
            return;
        }

        client = new Discord.Client({intents: [
            Discord.GatewayIntentBits.Guilds,
            Discord.GatewayIntentBits.GuildMessages,
            Discord.GatewayIntentBits.MessageContent,
        ]});

        logger.info('[Chat Relay] Logging into Discord.');

        try {
            await client.login(token);
        } catch (err) {
            logger.error(`[Chat Relay] Discord login error:\n${(err as Error).stack}`);
            await clientDestroy();
            return;
        }

        logger.info('[Chat Relay] Logged in Discord successfully.');
    };

    const sendMessage = async (instance_name: string, datetime: string, message: string) => {
        if (!client) return;

        const mapping = controller.config.get('chat_relay.discord_channel_mapping') as Record<string, string>;
        const channelId = mapping?.[instance_name];
        if (!channelId) return;

        let channel: Discord.Channel | null;

        try {
            channel = await client.channels.fetch(channelId);
        } catch (err) {
            if ((err as {code?: number}).code !== 10003) {
                logger.error(`[Chat Relay] Discord channel fetch error:\n${(err as Error).stack}`);
            }
            return;
        }

        if (channel === null || !channel.isSendable()) {
            logger.error(`[Chat Relay] Discord Channel ID ${channelId} is not a usable channel.`);
            return;
        }

        let msg = message;

        if (controller.config.get('chat_relay.datetime_on_message')) {
            msg = `${datetime} ${msg}`;
        }

        const send = (content: string) => channel.send({content, allowedMentions: {parse: []}});

        if (msg.length <= MAX_DISCORD_MESSAGE_LENGTH) {
            await send(msg);
            return;
        }

        let remaining = msg;

        while (remaining.length > 0) {
            let chunk = remaining.slice(0, MAX_DISCORD_MESSAGE_LENGTH);
            const lastSpace = chunk.lastIndexOf(' ');

            if (lastSpace > 0) {
                chunk = chunk.slice(0, lastSpace);
                remaining = remaining.slice(lastSpace).trim();
            } else {
                remaining = remaining.slice(MAX_DISCORD_MESSAGE_LENGTH).trim();
            }

            await send(chunk);
        }
    };

    controller.handle(ChatEvent, async (request: ChatEvent) => {
        const {instance_name, datetime, message} = request;
        await sendMessage(instance_name, datetime, message);
    });

    controller.config.on('fieldChanged', (field) => {
        if (field === 'chat_relay.discord_bot_token') {
            connect().catch(err => {
                logger.error(`[Chat Relay] Discord bot token:\n${(err as Error).stack}`);
            });
        }
    });

    controller.hooks.shutdown.attach(plugin.name, async () => {
        await clientDestroy();
    });

    await connect();
}
