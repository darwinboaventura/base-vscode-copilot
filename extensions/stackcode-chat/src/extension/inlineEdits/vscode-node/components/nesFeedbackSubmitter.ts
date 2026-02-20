/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, window } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ILogService } from '../../../../platform/log/common/logService';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';

/**
 * Represents a feedback file with its name and content.
 */
export interface FeedbackFile {
	name: string;
	content: string;
}

/**
 * Configuration for the feedback repository.
 */
interface FeedbackRepoConfig {
	readonly owner: string;
	readonly name: string;
	readonly apiUrl: string;
}

/**
 * Handles submission of NES feedback captures to a private GitHub repository.
 *
 * STACKCODE: This entire service is neutralized. It originally uploaded source code
 * and feedback data to api.github.com (microsoft/copilot-nes-feedback repo), which
 * is not an authorized backend. All public methods are no-ops.
 */
export class NesFeedbackSubmitter {

	private static readonly DEFAULT_REPO_CONFIG: FeedbackRepoConfig = {
		owner: 'microsoft',
		name: 'copilot-nes-feedback',
		apiUrl: 'https://api.github.com'
	};

	constructor(
		_logService: ILogService,
		_authenticationService: IAuthenticationService,
		_fetcherService: IFetcherService,
		_repoConfig: FeedbackRepoConfig = NesFeedbackSubmitter.DEFAULT_REPO_CONFIG
	) {
		// STACKCODE: Constructor kept for interface compatibility. All services are unused.
	}

	/**
	 * STACKCODE: Neutralized — this feature is not available in StackCode.
	 */
	public async submitFromFolder(_feedbackFolderUri: Uri): Promise<void> {
		window.showInformationMessage('NES feedback submission is not available in StackCode.');
		return;
	}
}
