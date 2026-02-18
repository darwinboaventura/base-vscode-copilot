/*---------------------------------------------------------------------------------------------
 *  StackCode - Stackspot AI Authentication
 *
 *  Implements ICopilotTokenManager using Stackspot AI OAuth2 client_credentials.
 *  When authenticated with Stackspot, creates a synthetic CopilotToken that satisfies
 *  the existing extension infrastructure. When not authenticated, throws
 *  GitHubLoginFailedError (same error the original code throws when GitHub auth fails)
 *  which causes the chatViewsWelcome "not signed in" UI to appear.
 *
 *  Credentials (realm, clientId, clientKey) are persisted in VS Code SecretStorage
 *  and automatically restored on extension startup.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { ILogService } from '../../log/common/logService';
import { StackspotAuthService } from '../../stackspot/auth';
import { StackspotCredentials } from '../../stackspot/types';
import { CopilotToken, ExtendedTokenInfo } from '../common/copilotToken';
import { ICopilotTokenManager } from '../common/copilotTokenManager';
import { GitHubLoginFailedError } from './copilotTokenManager';

// Secret storage keys
const SECRET_KEY_REALM = 'stackcode-realm';
const SECRET_KEY_CLIENT_ID = 'stackcode-client-id';
const SECRET_KEY_CLIENT_KEY = 'stackcode-client-key';

/**
 * A CopilotTokenManager that uses Stackspot AI for authentication.
 *
 * Flow:
 * 1. Extension starts → tryRestoreCredentials() attempts to restore from SecretStorage
 * 2. If no stored credentials → getCopilotToken() throws GitHubLoginFailedError
 * 3. ContextKeysContribution catches error → sets gitHubLoginFailed context → chatViewsWelcome shows login UI
 * 4. User clicks "Connect to StackSpot AI" → stackcode.login command fires → InputBox flow
 * 5. Credentials provided → login() called → credentials stored in SecretStorage
 * 6. getCopilotToken() now returns synthetic CopilotToken
 * 7. onDidCopilotTokenRefresh fires → ContextKeysContribution re-inspects → sets activated context
 * 8. ConversationFeature activates → chat UI appears
 * 9. On next startup, credentials are restored from SecretStorage automatically
 */
export class StackspotCopilotTokenManager extends Disposable implements ICopilotTokenManager {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidCopilotTokenRefresh = this._register(new Emitter<void>());
	readonly onDidCopilotTokenRefresh: Event<void> = this._onDidCopilotTokenRefresh.event;

	private readonly _authService: StackspotAuthService;
	private _cachedToken: CopilotToken | undefined;

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._authService = new StackspotAuthService();
	}

	/**
	 * Returns the StackspotAuthService instance for use by the proxy and other services.
	 */
	getAuthService(): StackspotAuthService {
		return this._authService;
	}

	/**
	 * Attempts to restore credentials from SecretStorage.
	 * Called by StackspotAuthContribution at startup.
	 * If credentials are found and valid, authenticates silently.
	 * Returns true if credentials were restored successfully.
	 */
	async tryRestoreCredentials(): Promise<boolean> {
		try {
			const realm = await this._extensionContext.secrets.get(SECRET_KEY_REALM);
			const clientId = await this._extensionContext.secrets.get(SECRET_KEY_CLIENT_ID);
			const clientKey = await this._extensionContext.secrets.get(SECRET_KEY_CLIENT_KEY);

			if (!realm || !clientId || !clientKey) {
				this._logService.debug('[stackcode] No stored credentials found in SecretStorage');
				return false;
			}

			this._logService.info('[stackcode] Restoring credentials from SecretStorage...');
			await this._authService.login({ realm, clientId, clientKey });
			this._cachedToken = undefined;
			this._onDidCopilotTokenRefresh.fire();
			this._logService.info('[stackcode] Credentials restored successfully');
			return true;
		} catch (e) {
			this._logService.error(e instanceof Error ? e : new Error(String(e)), '[stackcode] Failed to restore credentials from SecretStorage');
			// Clear potentially corrupted stored credentials
			await this._clearStoredCredentials();
			return false;
		}
	}

	/**
	 * Login with Stackspot AI credentials. After successful login,
	 * persists credentials in SecretStorage and fires onDidCopilotTokenRefresh
	 * which causes the extension to re-evaluate auth state and activate the chat UI.
	 */
	async login(credentials: StackspotCredentials): Promise<void> {
		console.log('[stackcode] StackspotCopilotTokenManager.login called, realm:', credentials.realm);
		await this._authService.login(credentials);
		console.log('[stackcode] authService.login succeeded, storing credentials...');
		// Persist credentials in SecretStorage for auto-restore on next startup
		await this._storeCredentials(credentials);
		this._cachedToken = undefined; // clear cache so next getCopilotToken() creates fresh token
		console.log('[stackcode] Firing onDidCopilotTokenRefresh');
		this._onDidCopilotTokenRefresh.fire();
	}

	/**
	 * Logout from Stackspot AI. Clears the token, removes stored credentials,
	 * and fires the event which causes the extension to show the login UI again.
	 */
	async logout(): Promise<void> {
		this._authService.logout();
		await this._clearStoredCredentials();
		this._cachedToken = undefined;
		this._onDidCopilotTokenRefresh.fire();
	}

	/**
	 * Returns whether the user is currently authenticated with Stackspot AI.
	 */
	isAuthenticated(): boolean {
		return this._authService.isAuthenticated();
	}

	/**
	 * Stores credentials in SecretStorage.
	 */
	private async _storeCredentials(credentials: StackspotCredentials): Promise<void> {
		try {
			await this._extensionContext.secrets.store(SECRET_KEY_REALM, credentials.realm);
			await this._extensionContext.secrets.store(SECRET_KEY_CLIENT_ID, credentials.clientId);
			await this._extensionContext.secrets.store(SECRET_KEY_CLIENT_KEY, credentials.clientKey);
			this._logService.debug('[stackcode] Credentials stored in SecretStorage');
		} catch (e) {
			this._logService.error(e instanceof Error ? e : new Error(String(e)), '[stackcode] Failed to store credentials in SecretStorage');
		}
	}

	/**
	 * Clears stored credentials from SecretStorage.
	 */
	private async _clearStoredCredentials(): Promise<void> {
		try {
			await this._extensionContext.secrets.delete(SECRET_KEY_REALM);
			await this._extensionContext.secrets.delete(SECRET_KEY_CLIENT_ID);
			await this._extensionContext.secrets.delete(SECRET_KEY_CLIENT_KEY);
			this._logService.debug('[stackcode] Credentials cleared from SecretStorage');
		} catch (e) {
			this._logService.error(e instanceof Error ? e : new Error(String(e)), '[stackcode] Failed to clear credentials from SecretStorage');
		}
	}

	/**
	 * Returns a CopilotToken if authenticated with Stackspot AI.
	 * Throws GitHubLoginFailedError if not authenticated — this is the same
	 * error that the original VSCodeCopilotTokenManager throws when GitHub
	 * auth fails, so the existing context key / welcome view infrastructure
	 * handles it correctly.
	 */
	async getCopilotToken(_force?: boolean): Promise<CopilotToken> {
		if (!this._authService.getCredentials()) {
			throw new GitHubLoginFailedError('GitHubLoginFailed');
		}

		try {
			// Ensure token is valid (will refresh if expired)
			const accessToken = await this._authService.getAccessToken();

			if (!this._cachedToken || _force) {
				this._cachedToken = this._createSyntheticCopilotToken(accessToken);
			}

			return this._cachedToken;
		} catch (e) {
			this._cachedToken = undefined;
			throw new GitHubLoginFailedError('GitHubLoginFailed');
		}
	}

	/**
	 * Reset token — clears cached token so next call refreshes.
	 */
	resetCopilotToken(_httpError?: number): void {
		this._cachedToken = undefined;
	}

	/**
	 * Creates a synthetic CopilotToken that satisfies the extension infrastructure.
	 * The token is a fake HMAC-signed format that the CopilotToken class can parse.
	 * All feature flags are set to enable full functionality.
	 */
	private _createSyntheticCopilotToken(accessToken: string): CopilotToken {
		const credentials = this._authService.getCredentials();
		const realm = credentials?.realm ?? 'stackspot';

		// Build a token string in the format CopilotToken.parseToken() expects:
		// key1=value1;key2=value2:signature
		const tokenFields = [
			`tid=stackspot-${realm}`,
			'exp=' + (Math.floor(Date.now() / 1000) + 3600),
			'sku=business',
			'st=dotcom',
			'chat=1',
			'ccr=1',
			'editor_preview_features=1',
			'mcp=1',
			'fcv1=1',
			`8kp=1`,
		].join(';');
		const syntheticTokenString = `${tokenFields}:${accessToken}`;

		const tokenInfo: ExtendedTokenInfo = {
			token: syntheticTokenString,
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			refresh_in: 3000,
			sku: 'business',
			individual: false,
			blackbird_clientside_indexing: false,
			code_quote_enabled: true,
			code_review_enabled: true,
			codesearch: false,
			copilotignore_enabled: false,
			vsc_electron_fetcher_v2: false,
			public_suggestions: 'enabled',
			telemetry: 'disabled',
			endpoints: {
				api: 'https://genai-inference-app.stackspot.com',
				proxy: 'https://genai-inference-app.stackspot.com',
			},
			organization_list: [],
			username: `stackspot-${realm}`,
			isVscodeTeamMember: false,
			copilot_plan: 'business',
			organization_login_list: [realm],
		};

		return new CopilotToken(tokenInfo);
	}
}
