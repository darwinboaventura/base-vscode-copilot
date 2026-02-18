/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancelablePromise, notCancellablePromise, raceCancellablePromises, timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandEvent, ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IExtensionService } from '../../extensions/common/extensions.js';

export class CommandService extends Disposable implements ICommandService {

	declare readonly _serviceBrand: undefined;

	private _extensionHostIsReady: boolean = false;
	private _starActivation: CancelablePromise<void> | null;

	private readonly _onWillExecuteCommand: Emitter<ICommandEvent> = this._register(new Emitter<ICommandEvent>());
	public readonly onWillExecuteCommand: Event<ICommandEvent> = this._onWillExecuteCommand.event;

	private readonly _onDidExecuteCommand = this._register(new Emitter<ICommandEvent>());
	public readonly onDidExecuteCommand: Event<ICommandEvent> = this._onDidExecuteCommand.event;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		this._extensionService.whenInstalledExtensionsRegistered().then(value => this._extensionHostIsReady = value);
		this._starActivation = null;
	}

	private _activateStar(): Promise<void> {
		if (!this._starActivation) {
			// wait for * activation, limited to at most 30s.
			this._starActivation = raceCancellablePromises([
				this._extensionService.activateByEvent(`*`),
				timeout(30000)
			]);
		}

		// This is wrapped with notCancellablePromise so it doesn't get cancelled
		// early because it is shared between consumers.
		return notCancellablePromise(this._starActivation);
	}

	async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
		this._logService.trace('CommandService#executeCommand', id);

		// STACKCODE DEBUG: trace command execution path
		if (id.startsWith('stackcode.')) {
			console.log(`[stackcode-cmd] executeCommand called: ${id}, args count: ${args.length}`);
		}

		const activationEvent = `onCommand:${id}`;
		const commandIsRegistered = !!CommandsRegistry.getCommand(id);

		if (id.startsWith('stackcode.')) {
			console.log(`[stackcode-cmd] commandIsRegistered: ${commandIsRegistered}, extensionHostIsReady: ${this._extensionHostIsReady}, activationEventIsDone: ${this._extensionService.activationEventIsDone(activationEvent)}`);
		}

		if (commandIsRegistered) {

			// if the activation event has already resolved (i.e. subsequent call),
			// we will execute the registered command immediately
			if (this._extensionService.activationEventIsDone(activationEvent)) {
				if (id.startsWith('stackcode.')) {
					console.log(`[stackcode-cmd] Path A: activationEventIsDone, calling _tryExecuteCommand`);
				}
				return this._tryExecuteCommand(id, args);
			}

			// if the extension host didn't start yet, we will execute the registered
			// command immediately and send an activation event, but not wait for it
			if (!this._extensionHostIsReady) {
				if (id.startsWith('stackcode.')) {
					console.log(`[stackcode-cmd] Path B: extensionHost not ready, calling _tryExecuteCommand`);
				}
				this._extensionService.activateByEvent(activationEvent); // intentionally not awaited
				return this._tryExecuteCommand(id, args);
			}

			// STACKCODE FIX: For stackcode.* commands, the extension is activated via
			// onStartupFinished (not via onCommand:), so activationEventIsDone returns
			// false even though the handler is already registered. Since the command IS
			// registered and the extension host IS ready, we can safely execute directly
			// and fire activateByEvent without awaiting it.
			if (id.startsWith('stackcode.')) {
				console.log(`[stackcode-cmd] Path A2: command registered + extHost ready, executing directly`);
				this._extensionService.activateByEvent(activationEvent); // fire-and-forget
				return this._tryExecuteCommand(id, args);
			}

			// we will wait for a simple activation event (e.g. in case an extension wants to overwrite it)
			await this._extensionService.activateByEvent(activationEvent);
			return this._tryExecuteCommand(id, args);
		}

		// finally, if the command is not registered we will send a simple activation event
		// as well as a * activation event raced against registration and against 30s
		if (id.startsWith('stackcode.')) {
			console.log(`[stackcode-cmd] Path D: command NOT registered, awaiting activation + registration`);
		}
		await Promise.all([
			this._extensionService.activateByEvent(activationEvent),
			raceCancellablePromises<unknown>([
				// race * activation against command registration
				this._activateStar(),
				Event.toPromise(Event.filter(CommandsRegistry.onDidRegisterCommand, e => e === id))
			]),
		]);

		if (id.startsWith('stackcode.')) {
			console.log(`[stackcode-cmd] Path D: activation resolved, calling _tryExecuteCommand`);
		}
		return this._tryExecuteCommand(id, args);
	}

	private _tryExecuteCommand(id: string, args: unknown[]): Promise<any> {
		const command = CommandsRegistry.getCommand(id);
		if (!command) {
			if (id.startsWith('stackcode.')) {
				console.error(`[stackcode-cmd] _tryExecuteCommand: command '${id}' NOT FOUND in registry`);
			}
			return Promise.reject(new Error(`command '${id}' not found`));
		}
		if (id.startsWith('stackcode.')) {
			console.log(`[stackcode-cmd] _tryExecuteCommand: invoking handler for '${id}'`);
		}
		try {
			this._onWillExecuteCommand.fire({ commandId: id, args });
			const result = this._instantiationService.invokeFunction(command.handler, ...args);
			if (id.startsWith('stackcode.')) {
				console.log(`[stackcode-cmd] _tryExecuteCommand: handler returned, result type: ${typeof result}`);
			}
			this._onDidExecuteCommand.fire({ commandId: id, args });
			return Promise.resolve(result);
		} catch (err) {
			if (id.startsWith('stackcode.')) {
				console.error(`[stackcode-cmd] _tryExecuteCommand: handler threw error:`, err);
			}
			return Promise.reject(err);
		}
	}

	public override dispose(): void {
		super.dispose();
		this._starActivation?.cancel();
	}
}

registerSingleton(ICommandService, CommandService, InstantiationType.Delayed);
