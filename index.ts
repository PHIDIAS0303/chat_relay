import type * as lib from '@clusterio/lib';
import {Type} from '@sinclair/typebox';
import type {Static} from '@sinclair/typebox';

/* Shared declarations for the chat relay plugin.
 * `sanitiseForFactorio` is used by both processes: the controller cleans text
 * before it leaves, and the instance cleans it again before it reaches game.print.
 */

export const chatFromDiscord = Type.Object({
    author_name: Type.String(),
    channel_id: Type.String(),
    datetime: Type.String(),
    message: Type.String(),
});

export type ChatFromDiscord = Static<typeof chatFromDiscord>;

export class ChatFromDiscordEvent {
    declare ['constructor']: typeof ChatFromDiscordEvent;
    static type = 'event' as const;
    static src = 'controller' as const;
    static dst = 'instance' as const;
    static plugin = 'chat_relay' as const;
    static permission = null;

    constructor(
        public author_name: string,
        public channel_id: string,
        public datetime: string,
        public message: string,
    ) {}

    static jsonSchema = chatFromDiscord;

    static fromJSON(json: Static<typeof ChatFromDiscordEvent.jsonSchema>) {
        return new this(json.author_name, json.channel_id, json.datetime, json.message);
    }
}

export const MAX_INBOUND_LENGTH = 400;

// Factorio renders these, so a Discord user could spoof a colour, an item link,
// or a fake speaker line. Whitelist the real tags rather than matching \[.*\],
// which would also eat innocent text like "array[0]" or "[lol]".
const RICH_TEXT_RE = new RegExp(
    String.raw`\[/?(?:color|font|item|entity|technology|recipe|fluid|tile|virtual-signal`
    + String.raw`|gps|img|specialisation|achievement|train|planet|space-location|quality)(?:=[^\]]*)?\]`,
    'gi',
);

/** Make arbitrary text safe to print in-game. Shared by both processes. */
export function sanitiseForFactorio(text: string, limit = MAX_INBOUND_LENGTH): string {
    let clean = text
        .replace(RICH_TEXT_RE, '')
        .replace(/[\u0000-\u001f\u007f]/g, '')   // control chars, including newlines
        .replace(/\s+/g, ' ')
        .trim();

    // Code points, not UTF-16 units: emoji paste from Discord is real here, and a
    // lone surrogate in a Lua string sent over stdin is not something I'd trust.
    const chars = Array.from(clean);
    if (chars.length > limit) {
        clean = `${chars.slice(0, limit - 3).join('').trimEnd()}...`;
    }

    return clean;
}

export class ChatEvent {
    declare ['constructor']: typeof ChatEvent;
    static type = 'event' as const;
    static src = 'instance' as const;
    static dst = 'controller' as const;
    static plugin = 'chat_relay' as const;
    static permission = null;

    constructor(
        public instance_name: string,
        public datetime: string,
        public message: string,
    ) {}

    static jsonSchema = Type.Object({
        'instance_name': Type.String(),
        'datetime': Type.String(),
        'message': Type.String(),
    });

    static fromJSON(json: Static<typeof ChatEvent.jsonSchema>) {
        return new this(json.instance_name, json.datetime, json.message);
    }
}

declare module '@clusterio/lib' {
    interface ControllerConfigFields {
        'chat_relay.discord_bot_token': string;
        'chat_relay.datetime_on_message': boolean;
        'chat_relay.discord_channel_mapping': Record<string, string>;
    }
}

export const plugin: lib.PluginDeclaration = {
    name: 'chat_relay',
    title: 'Chat Relay',
    description: 'Bidirectional chat relay between Factorio and Discord.',
    webEntrypoint: './web',
    instanceEntrypoint: 'dist/node/instance.js',
    controllerEntrypoint: 'dist/node/controller.js',
    controllerConfigFields: {
        'chat_relay.discord_bot_token': {
            title: 'Discord Bot Token',
            description: 'API Token',
            type: 'string',
            credential: ['controller'],
        },
        'chat_relay.datetime_on_message': {
            title: 'Message Datetime',
            description: 'Append datetime in front',
            type: 'boolean',
            initialValue: true,
        },
        'chat_relay.discord_channel_mapping': {
            title: 'Discord Channels',
            description: 'Instance and Discord channel ID relations, used in both directions',
            type: 'object',
            initialValue: {
                'S1': '123',
            },
        },
    },
    messages: [
        ChatEvent,
        ChatFromDiscordEvent,
    ],
};
