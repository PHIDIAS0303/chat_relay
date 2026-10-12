import type {InstancePluginContext} from '@clusterio/host';
import {ChatEvent} from './index.js';

export default async function(context: InstancePluginContext) {
	const {instance, host, plugin} = context;
	await InstancePlugin.fromContext(context);
	let queue: [string, string][] = [];

	instance.hooks.controllerConnectionEvent.attach(plugin.name, async (event) => {
		if (event !== 'connect' || queue.length === 0) {
			return;
		}

        const pending = queue;
        queue = [];
        const failed: [string, string][] = [];

        for (const [action, content] of pending) {
            try {
                await instance.sendTo('controller', new ChatEvent(instance, action, content));
            } catch (err) {
                failed.push([action, content]);
            }
        }

        queue = failed;
	});

	instance.hooks.output.attach(plugin.name, async (output) => {
		if (output.type !== 'action') {
            return;
        }

		if (host.connector.connected) {
            try {
                await instance.sendTo('controller', new ChatEvent(instance, output.action, output.message));
            } catch (err) {
                queue.push([output.action, output.message]);
            }
		} else {
			queue.push([output.action, output.message]);
		}
	});
}
