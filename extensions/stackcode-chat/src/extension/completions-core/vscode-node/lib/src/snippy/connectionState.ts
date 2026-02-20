/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
// STACKCODE: Removed imports for IInstantiationService, ICompletionsLogTargetService, getLastKnownEndpoints,
// ICompletionsFetcherService, codeReferenceLogger — all were used only by attemptToPing (origin-tracker ping).

type ConnectionAPI = {
	listen: (cb: () => void) => { dispose: () => void };
	setConnected: () => void;
	setRetrying: () => void;
	setDisconnected: () => void;
	setDisabled: () => void;
	enableRetry: (accessor: ServicesAccessor, initialTimeout?: number) => void;
	isConnected: () => boolean;
	isDisconnected: () => boolean;
	isRetrying: () => boolean;
	isDisabled: () => boolean;
	isInitialWait: () => boolean;
};

type ConnectionState = {
	connection: 'connected' | 'disconnected' | 'retry' | 'disabled';
	maxAttempts: number;
	retryAttempts: number;
	initialWait: boolean;
};

const InitialTimeout = 3000;
const BaseRetryTime = 2;
const MaxRetryTime = 256;
const MaxAttempts = Math.log(MaxRetryTime) / Math.log(BaseRetryTime) / BaseRetryTime;

const state: ConnectionState = {
	connection: 'disabled',
	maxAttempts: MaxAttempts,
	retryAttempts: 0,
	initialWait: false,
};

let stateAPI: ConnectionAPI;
const handlers: Array<() => void> = [];

function registerConnectionState(): ConnectionAPI {
	if (stateAPI) {
		return stateAPI;
	}

	function subscribe(cb: () => void) {
		handlers.push(cb);
		return () => {
			const index = handlers.indexOf(cb);
			if (index !== -1) {
				handlers.splice(index, 1);
			}
		};
	}

	function afterUpdateConnection() {
		for (const handler of handlers) {
			handler();
		}
	}

	function updateConnection(status: ConnectionState['connection']) {
		if (state.connection === status) {
			return;
		}

		state.connection = status;
		afterUpdateConnection();
	}

	function isConnected() {
		return state.connection === 'connected';
	}

	function isDisconnected() {
		return state.connection === 'disconnected';
	}

	function isRetrying() {
		return state.connection === 'retry';
	}

	function isDisabled() {
		return state.connection === 'disabled';
	}

	function setConnected() {
		updateConnection('connected');
		setInitialWait(false);
	}

	function setDisconnected() {
		updateConnection('disconnected');
	}

	function setRetrying() {
		updateConnection('retry');
	}

	function setDisabled() {
		updateConnection('disabled');
	}

	function setInitialWait(enabled: boolean) {
		if (state.initialWait !== enabled) {
			state.initialWait = enabled;
		}
	}

	function enableRetry(_accessor: ServicesAccessor, _initialTimeout = InitialTimeout) {
		// STACKCODE: origin-tracker ping neutralized — no requests to GitHub servers.
		if (isRetrying()) {
			return;
		}
		setDisabled();
	}

	function isInitialWait() {
		return state.initialWait;
	}

	// STACKCODE: attemptToPing removed — it pinged origin-tracker.githubusercontent.com

	function listen(cb: () => void) {
		const disposer = subscribe(cb);
		return { dispose: disposer };
	}

	stateAPI = {
		setConnected,
		setDisconnected,
		setRetrying,
		setDisabled,
		enableRetry,
		listen,
		isConnected,
		isDisconnected,
		isRetrying,
		isDisabled,
		isInitialWait,
	};

	return stateAPI;
}

export const ConnectionState = registerConnectionState();
