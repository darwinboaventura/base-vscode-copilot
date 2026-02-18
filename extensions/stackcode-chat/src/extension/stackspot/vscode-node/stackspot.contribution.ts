/*---------------------------------------------------------------------------------------------
 *  StackCode - Stackspot AI Authentication Contribution
 *
 *  Registers the stackcode.login and stackcode.logout commands.
 *  The login command shows sequential InputBoxes for Realm, Client ID, and Client Key,
 *  then authenticates with Stackspot AI. On success, the chat UI appears.
 *  On logout, the login welcome view appears again.
 *
 *  On startup, attempts to restore credentials from SecretStorage so the user
 *  doesn't need to re-enter them every time VS Code restarts.
 *--------------------------------------------------------------------------------------------*/

import { commands, window } from 'vscode';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { StackspotCopilotTokenManager } from '../../../platform/authentication/vscode-node/stackspotCopilotTokenManager';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

export class StackspotAuthContribution extends Disposable {
	constructor(
		@ICopilotTokenManager private readonly _tokenManager: ICopilotTokenManager,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		console.log('[stackcode] StackspotAuthContribution constructor called');
		try {
			this._registerCommands();
			console.log('[stackcode] Commands registered successfully');
		} catch (e) {
			console.error('[stackcode] Failed to register commands:', e);
		}
		// Attempt to restore credentials from SecretStorage at startup
		this._tryRestoreCredentials();
	}

	private _registerCommands(): void {
		this._register(commands.registerCommand('stackcode.login', (args?: { realm: string; clientId: string; clientKey: string }) => this._login(args)));
		this._register(commands.registerCommand('stackcode.logout', () => this._logout()));
	}

	/**
	 * Attempts to restore credentials from SecretStorage.
	 * Runs at startup, silently — if it fails, the user just sees the login UI.
	 */
	private async _tryRestoreCredentials(): Promise<void> {
		try {
			const tokenManager = this._tokenManager as StackspotCopilotTokenManager;
			const restored = await tokenManager.tryRestoreCredentials();
			if (restored) {
				this._logService.info('[stackcode] Auto-restored credentials from SecretStorage');
			}
		} catch (e) {
			this._logService.debug('[stackcode] Could not restore credentials');
		}
	}

	private async _login(args?: { realm: string; clientId: string; clientKey: string }): Promise<void> {
		console.log('[stackcode] _login called, args present:', !!args, args ? `realm=${args.realm}` : 'no args');
		this._logService.info('[stackcode] _login called');
		const tokenManager = this._tokenManager as StackspotCopilotTokenManager;

		let realm: string;
		let clientId: string;
		let clientKey: string;

		if (args?.realm && args?.clientId && args?.clientKey) {
			// Called directly from the inline login form with credentials
			realm = args.realm;
			clientId = args.clientId;
			clientKey = args.clientKey;
			console.log('[stackcode] Using inline form credentials');
		} else {
			// Fallback: show sequential InputBoxes (e.g. from Command Palette)
			const realmInput = await window.showInputBox({
				title: 'StackSpot AI - Connect (1/3)',
				prompt: 'Enter your Realm',
				placeHolder: 'e.g. my-company',
				ignoreFocusOut: true,
				validateInput: (value) => {
					if (!value.trim()) {
						return 'Realm is required';
					}
					return undefined;
				}
			});
			if (!realmInput) {
				return; // User cancelled
			}

			const clientIdInput = await window.showInputBox({
				title: 'StackSpot AI - Connect (2/3)',
				prompt: 'Enter your Client ID',
				placeHolder: 'Client ID',
				ignoreFocusOut: true,
				validateInput: (value) => {
					if (!value.trim()) {
						return 'Client ID is required';
					}
					return undefined;
				}
			});
			if (!clientIdInput) {
				return; // User cancelled
			}

			const clientKeyInput = await window.showInputBox({
				title: 'StackSpot AI - Connect (3/3)',
				prompt: 'Enter your Client Key',
				placeHolder: 'Client Key',
				password: true,
				ignoreFocusOut: true,
				validateInput: (value) => {
					if (!value.trim()) {
						return 'Client Key is required';
					}
					return undefined;
				}
			});
			if (!clientKeyInput) {
				return; // User cancelled
			}

			realm = realmInput.trim();
			clientId = clientIdInput.trim();
			clientKey = clientKeyInput.trim();
		}

		// Attempt login
		try {
			console.log('[stackcode] About to call tokenManager.login with realm:', realm);
			await window.withProgress(
				{
					location: { viewId: 'workbench.panel.chat.view.copilot' },
					title: 'Connecting to StackSpot AI...',
				},
				async () => {
					console.log('[stackcode] Inside withProgress callback');
					await tokenManager.login({
						realm,
						clientId,
						clientKey,
					});
					console.log('[stackcode] tokenManager.login completed');
				}
			);
			console.log('[stackcode] withProgress completed');
			this._logService.info('[stackcode] Successfully connected to StackSpot AI');
			window.showInformationMessage('Successfully connected to StackSpot AI!');
		} catch (error) {
			this._logService.error('[stackcode] Failed to connect to StackSpot AI:', error);
			const message = error instanceof Error ? error.message : String(error);
			window.showErrorMessage(`Failed to connect to StackSpot AI: ${message}`);
			throw error; // Re-throw so the login form can show the error
		}
	}

	private async _logout(): Promise<void> {
		const tokenManager = this._tokenManager as StackspotCopilotTokenManager;
		await tokenManager.logout();
		this._logService.info('[stackcode] Disconnected from StackSpot AI');
		window.showInformationMessage('Disconnected from StackSpot AI.');
	}
}
