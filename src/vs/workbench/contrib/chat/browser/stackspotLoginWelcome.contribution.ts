/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { chatViewsWelcomeRegistry, IChatViewsWelcomeServices } from './viewsWelcome/chatViewsWelcome.js';

const $ = dom.$;

export const STACKSPOT_SIGNED_IN_KEY = new RawContextKey<boolean>('stackspot.signedIn', false);
export const STACKSPOT_SIGNED_OUT_KEY = new RawContextKey<boolean>('stackspot.signedOut', false);

// Register the welcome view descriptor for the login form
chatViewsWelcomeRegistry.register({
	icon: FileAccess.asBrowserUri('vs/workbench/contrib/chat/browser/widget/media/stackspot-icon.svg'),
	title: localize('stackspot.welcome.title', "StackSpot AI"),
	content: new MarkdownString(localize('stackspot.welcome.message', "Enter your credentials to connect to StackSpot AI.")),
	when: ContextKeyExpr.equals('stackspot.signedOut', true),
	inputPartFactory: (store, services) => createLoginForm(store, services)
});

function createLoginForm(store: DisposableStore, services: IChatViewsWelcomeServices): HTMLElement {
	const container = $('div.stackspot-login-form');

	// Client ID
	const clientIdGroup = dom.append(container, $('div.form-group'));
	const clientIdLabel = dom.append(clientIdGroup, $('label'));
	clientIdLabel.textContent = localize('stackspot.form.clientId', "Client ID");
	(clientIdLabel as HTMLLabelElement).htmlFor = 'stackspot-client-id';
	const clientIdInput = dom.append(clientIdGroup, $('input')) as HTMLInputElement;
	clientIdInput.type = 'text';
	clientIdInput.id = 'stackspot-client-id';
	clientIdInput.placeholder = localize('stackspot.form.clientId.placeholder', "Enter your Client ID");

	// Client Key
	const clientKeyGroup = dom.append(container, $('div.form-group'));
	const clientKeyLabel = dom.append(clientKeyGroup, $('label'));
	clientKeyLabel.textContent = localize('stackspot.form.clientKey', "Client Key");
	(clientKeyLabel as HTMLLabelElement).htmlFor = 'stackspot-client-key';
	const clientKeyInput = dom.append(clientKeyGroup, $('input')) as HTMLInputElement;
	clientKeyInput.type = 'password';
	clientKeyInput.id = 'stackspot-client-key';
	clientKeyInput.placeholder = localize('stackspot.form.clientKey.placeholder', "Enter your Client Key");

	// Realm (INPUT, not select — user explicitly requested this)
	const realmGroup = dom.append(container, $('div.form-group'));
	const realmLabel = dom.append(realmGroup, $('label'));
	realmLabel.textContent = localize('stackspot.form.realm', "Realm");
	(realmLabel as HTMLLabelElement).htmlFor = 'stackspot-realm';
	const realmInput = dom.append(realmGroup, $('input')) as HTMLInputElement;
	realmInput.type = 'text';
	realmInput.id = 'stackspot-realm';
	realmInput.placeholder = localize('stackspot.form.realm.placeholder', "e.g. my-company");

	// Error message
	const errorMsg = dom.append(container, $('div.error-message'));
	errorMsg.textContent = '';

	// Submit button
	const submitBtn = dom.append(container, $('button.submit-btn')) as HTMLButtonElement;
	submitBtn.type = 'button';
	submitBtn.textContent = localize('stackspot.form.submit', "Connect and Continue");

	// Disclaimer
	const disclaimer = dom.append(container, $('div.disclaimer'));
	disclaimer.textContent = localize('stackspot.form.disclaimer', "Your credentials are stored securely in the application.");

	const setLoading = (loading: boolean) => {
		submitBtn.disabled = loading;
		submitBtn.textContent = loading
			? localize('stackspot.form.connecting', "Connecting...")
			: localize('stackspot.form.submit', "Connect and Continue");
	};

	const setError = (msg: string) => {
		errorMsg.textContent = msg;
		errorMsg.classList.toggle('visible', !!msg);
	};

	const handleSubmit = async () => {
		const clientId = clientIdInput.value.trim();
		const clientKey = clientKeyInput.value.trim();
		const realm = realmInput.value.trim();

		if (!clientId || !clientKey || !realm) {
			setError(localize('stackspot.form.required', "All fields are required."));
			return;
		}

		setError('');
		setLoading(true);

		try {
			await services.commandService.executeCommand('stackcode.login', { realm, clientId, clientKey });
		} catch (err) {
			setError(localize('stackspot.form.error', "Login failed: {0}", (err as Error)?.message ?? String(err)));
		} finally {
			setLoading(false);
		}
	};

	store.add(dom.addDisposableListener(submitBtn, dom.EventType.CLICK, () => handleSubmit()));

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSubmit();
		}
	};
	store.add(dom.addDisposableListener(clientIdInput, dom.EventType.KEY_DOWN, onKeyDown));
	store.add(dom.addDisposableListener(clientKeyInput, dom.EventType.KEY_DOWN, onKeyDown));
	store.add(dom.addDisposableListener(realmInput, dom.EventType.KEY_DOWN, onKeyDown));

	return container;
}

/**
 * Workbench contribution that manages the `stackspot.signedIn` and `stackspot.signedOut`
 * context keys by listening to the authentication provider registration and session changes.
 *
 * IMPORTANT: Both keys start as `false` (loading state). We ONLY set `signedOut = true`
 * after confirming the provider IS registered but has no sessions. We never set it before
 * the provider is registered — that would cause the login form to flash on startup before
 * the extension has had a chance to restore credentials from SecretStorage.
 */
class StackspotAuthContextContribution extends Disposable {

	static readonly ID = 'workbench.contrib.stackspotAuthContext';

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
	) {
		super();

		const signedInKey = STACKSPOT_SIGNED_IN_KEY.bindTo(this.contextKeyService);
		const signedOutKey = STACKSPOT_SIGNED_OUT_KEY.bindTo(this.contextKeyService);

		// Both keys start as false — no login form shown during loading
		signedInKey.set(false);
		signedOutKey.set(false);

		const updateKeys = (isSignedIn: boolean) => {
			signedInKey.set(isSignedIn);
			signedOutKey.set(!isSignedIn);
		};

		const checkSessions = async () => {
			try {
				const sessions = await this.authenticationService.getSessions('stackspot');
				updateKeys(sessions.length > 0);
			} catch {
				updateKeys(false);
			}
		};

		// When the provider registers, check if it already has sessions
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => {
			if (e.id === 'stackspot') {
				checkSessions();
			}
		}));

		// When sessions change (login/logout), update keys
		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId === 'stackspot') {
				checkSessions();
			}
		}));

		// When the provider unregisters, we are signed out
		this._register(this.authenticationService.onDidUnregisterAuthenticationProvider(e => {
			if (e.id === 'stackspot') {
				updateKeys(false);
			}
		}));

		// If the provider is already registered at construction time, check now
		if (this.authenticationService.isAuthenticationProviderRegistered('stackspot')) {
			checkSessions();
		}
		// Otherwise: both keys stay false until onDidRegisterAuthenticationProvider fires.
		// The login form will NOT appear during this loading period — it only appears
		// when stackspot.signedOut === true, which requires the provider to be registered first.
	}
}

registerWorkbenchContribution2(StackspotAuthContextContribution.ID, StackspotAuthContextContribution, WorkbenchPhase.BlockStartup);
