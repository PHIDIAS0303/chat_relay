import type * as lib from '@clusterio/lib';
import type {Instance, InstancePluginContext} from '@clusterio/host';
import {Type, Static} from '@sinclair/typebox';

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

	static json_schema = Type.Object({
		'instance_name': Type.String(),
		'datetime': Type.String(),
		'message': Type.String(),
	});

	static fromJSON(json: Static<typeof ChatEvent.json_schema>) {
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
	description: 'One way chat relay to Discord.',
	webEntrypoint: './web',
	instanceEntrypoint: 'dist/node/instance.js',
	controllerEntrypoint: 'dist/node/controller.js',
	controllerConfigFields: {
		'chat_relay.discord_bot_token': {
			title: 'Discord Bot Token',	
			description: 'API Token',
			type: 'string',
			credential: ['controller']
		},
		'chat_relay.datetime_on_message': {
			title: 'Message Datetime',
			description: 'Append datetime in front',
			type: 'boolean',
			initialValue: true
		},
		'chat_relay.discord_channel_mapping': {
			title: 'Discord Channels',
			description: 'Instance and Discord channel ID relations',
			type: 'object',
			initialValue: {
				'S1': '123'
			},
		},
	},
	messages: [
		ChatEvent,
	],
};
