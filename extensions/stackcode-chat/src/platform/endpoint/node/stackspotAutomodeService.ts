/*---------------------------------------------------------------------------------------------
 *  StackCode - Stackspot AI Automode Service
 *
 *  Replaces the upstream AutomodeService which calls GitHub CAPI's /auto_models
 *  endpoint. For Stackspot AI, there is no auto-model selection API — we simply
 *  return the default chat agent for the current realm.
 *
 *  This avoids:
 *  - Calling GitHub CAPI (which would fail with Stackspot auth)
 *  - Creating AutoChatEndpoint (which requires CopilotChatEndpoint dependencies)
 *  - The "GPT-4o · 0x" bug caused by CAPI returning gpt-4o as selected_model
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest } from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../log/common/logService';
import { IChatEndpoint } from '../../networking/common/networking';
import { IAutomodeService } from './automodeService';

/**
 * Stackspot-aware automode service that simply returns the first (default)
 * endpoint from the known endpoints list.
 *
 * Marks the returned endpoint with `_isStackspotAutoDefault = true` so
 * languageModelAccess.ts can identify it and avoid duplicate picker entries.
 */
export class StackspotAutomodeService extends Disposable implements IAutomodeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._logService.info('[stackcode] StackspotAutomodeService initialized — no CAPI auto-model calls');
	}

	async resolveAutoModeEndpoint(_chatRequest: ChatRequest | undefined, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		if (!knownEndpoints.length) {
			throw new Error('[stackcode] No endpoints available for auto mode resolution');
		}

		// Find the endpoint marked as fallback (which is how is_chat_default maps), or fall back to the first one
		const defaultEndpoint = knownEndpoints.find(e => e.isFallback) ?? knownEndpoints[0];

		this._logService.trace(`[stackcode] Auto mode resolved to: ${defaultEndpoint.name} (${defaultEndpoint.model})`);

		return defaultEndpoint;
	}
}
