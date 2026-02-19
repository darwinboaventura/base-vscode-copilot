/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { chatViewsWelcomeRegistry, IChatViewsWelcomeServices } from './viewsWelcome/chatViewsWelcome.js';

const $ = dom.$;

// Register the welcome view descriptor for the login form.
// This uses the same context key that the extension's ContextKeysContribution sets
// when authentication fails (gitHubLoginFailed = true). Our descriptor is registered
// first (at module-load time, before extension descriptors), so it wins when the
// condition matches.
chatViewsWelcomeRegistry.register({
	icon: FileAccess.asBrowserUri('vs/workbench/contrib/chat/browser/widget/media/stackspot-icon.svg'),
	title: localize('stackspot.welcome.title', "StackSpot AI"),
	content: new MarkdownString(localize('stackspot.welcome.message', "Enter your credentials to connect to StackSpot AI.")),
	when: ContextKeyExpr.equals('github.copilot.interactiveSession.gitHubLoginFailed', true),
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
