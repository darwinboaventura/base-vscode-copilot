/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../../base/browser/cssValue.js';
import * as dom from '../../../../../base/browser/dom.js';
import { createCSSRule } from '../../../../../base/browser/domStylesheets.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { IRenderedMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action, IAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IChatWidgetService } from '../chat.js';
import { chatViewsWelcomeRegistry, IChatViewsWelcomeDescriptor } from './chatViewsWelcome.js';

const $ = dom.$;

export interface IViewWelcomeDelegate {
	readonly onDidChangeViewWelcomeState: Event<void>;
	shouldShowWelcome(): boolean;
}

export class ChatViewWelcomeController extends Disposable {
	private element: HTMLElement | undefined;

	private enabled = false;
	private readonly enabledDisposables = this._register(new DisposableStore());
	private readonly renderDisposables = this._register(new DisposableStore());

	private readonly _isShowingWelcome: ISettableObservable<boolean> = observableValue(this, false);
	public get isShowingWelcome(): IObservable<boolean> {
		return this._isShowingWelcome;
	}

	constructor(
		private readonly container: HTMLElement,
		private readonly delegate: IViewWelcomeDelegate,
		private readonly location: ChatAgentLocation,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IInstantiationService private instantiationService: IInstantiationService,
	) {
		super();

		this.element = dom.append(this.container, dom.$('.chat-view-welcome'));
		this._register(Event.runAndSubscribe(
			delegate.onDidChangeViewWelcomeState,
			() => this.update()));
		this._register(chatViewsWelcomeRegistry.onDidChange(() => this.update(true)));
	}

	getMatchingWelcomeView(): IChatViewsWelcomeDescriptor | undefined {
		const descriptors = chatViewsWelcomeRegistry.get();
		const matchingDescriptors = descriptors.filter(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));
		return matchingDescriptors.at(0);
	}

	private update(force?: boolean): void {
		const enabled = this.delegate.shouldShowWelcome();
		if (this.enabled === enabled && !force) {
			return;
		}

		this.enabled = enabled;
		this.enabledDisposables.clear();

		if (!enabled) {
			this.container.classList.toggle('chat-view-welcome-visible', false);
			this.renderDisposables.clear();
			this._isShowingWelcome.set(false, undefined);
			return;
		}

		const descriptors = chatViewsWelcomeRegistry.get();
		if (descriptors.length) {
			this.render(descriptors);

			const descriptorKeys: Set<string> = new Set(descriptors.flatMap(d => d.when.keys()));
			this.enabledDisposables.add(this.contextKeyService.onDidChangeContext(e => {
				if (e.affectsSome(descriptorKeys)) {
					this.render(descriptors);
				}
			}));
		}
	}

	/**
	 * Checks if the matching descriptor is the StackCode login descriptor.
	 * We detect this by checking if the `when` clause contains the
	 * `github.copilot.interactiveSession.gitHubLoginFailed` key and the
	 * content references the `stackcode.login` command.
	 */
	private _isStackCodeLoginDescriptor(descriptor: IChatViewsWelcomeDescriptor): boolean {
		const keys = descriptor.when.keys();
		return keys.includes('github.copilot.interactiveSession.gitHubLoginFailed')
			&& descriptor.content.value.includes('stackcode.login');
	}

	private render(descriptors: ReadonlyArray<IChatViewsWelcomeDescriptor>): void {
		this.renderDisposables.clear();
		dom.clearNode(this.element!);

		const matchingDescriptors = descriptors.filter(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));
		const enabledDescriptor = matchingDescriptors.at(0);
		if (enabledDescriptor) {
			// STACKCODE: If this is the StackCode login descriptor, render the custom login form
			if (this._isStackCodeLoginDescriptor(enabledDescriptor)) {
				const loginView = this.renderDisposables.add(this.instantiationService.createInstance(StackCodeLoginPart));
				this.element!.appendChild(loginView.element);
			} else {
				const content: IChatViewWelcomeContent = {
					icon: enabledDescriptor.icon,
					title: enabledDescriptor.title,
					message: enabledDescriptor.content
				};
				const welcomeView = this.renderDisposables.add(this.instantiationService.createInstance(ChatViewWelcomePart, content, { firstLinkToButton: true, location: this.location }));
				this.element!.appendChild(welcomeView.element);
			}
			this.container.classList.toggle('chat-view-welcome-visible', true);
			this._isShowingWelcome.set(true, undefined);
		} else {
			this.container.classList.toggle('chat-view-welcome-visible', false);
			this._isShowingWelcome.set(false, undefined);
		}
	}
}

export interface IChatViewWelcomeContent {
	readonly icon?: ThemeIcon | URI;
	readonly title: string;
	readonly message: IMarkdownString;
	readonly additionalMessage?: string | IMarkdownString;
	tips?: IMarkdownString;
	readonly inputPart?: HTMLElement;
	readonly suggestedPrompts?: readonly IChatSuggestedPrompts[];
	readonly useLargeIcon?: boolean;
}

export interface IChatSuggestedPrompts {
	readonly icon?: ThemeIcon;
	readonly label: string;
	readonly description?: string;
	readonly prompt: string;
	readonly uri?: URI;
}

export interface IChatViewWelcomeRenderOptions {
	readonly firstLinkToButton?: boolean;
	readonly location: ChatAgentLocation;
	readonly isWidgetAgentWelcomeViewContent?: boolean;
}

export class ChatViewWelcomePart extends Disposable {
	public readonly element: HTMLElement;

	constructor(
		public readonly content: IChatViewWelcomeContent,
		options: IChatViewWelcomeRenderOptions | undefined,
		@IOpenerService private openerService: IOpenerService,
		@ILogService private logService: ILogService,
		@IChatWidgetService private chatWidgetService: IChatWidgetService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();

		this.element = dom.$('.chat-welcome-view');

		try {

			// Icon
			const icon = dom.append(this.element, $('.chat-welcome-view-icon'));
			if (content.useLargeIcon) {
				icon.classList.add('large-icon');
			}
			if (content.icon) {
				if (ThemeIcon.isThemeIcon(content.icon)) {
					const iconElement = renderIcon(content.icon);
					icon.appendChild(iconElement);
				} else if (URI.isUri(content.icon)) {
					const cssUrl = asCSSUrl(content.icon);
					const hash = new StringSHA1();
					hash.update(cssUrl);
					const iconId = `chat-welcome-icon-${hash.digest()}`;
					const iconClass = `.chat-welcome-view-icon.${iconId}`;

					createCSSRule(iconClass, `
					mask: ${cssUrl} no-repeat 50% 50%;
					-webkit-mask: ${cssUrl} no-repeat 50% 50%;
					background-color: var(--vscode-icon-foreground);
				`);
					icon.classList.add(iconId, 'custom-icon');
				}
			}
			const title = dom.append(this.element, $('.chat-welcome-view-title'));
			title.textContent = content.title;

			const message = dom.append(this.element, $('.chat-welcome-view-message'));

			const messageResult = this.renderMarkdownMessageContent(content.message, options);
			dom.append(message, messageResult.element);

			// Additional message
			if (content.additionalMessage) {
				const disclaimers = dom.append(this.element, $('.chat-welcome-view-disclaimer'));
				if (typeof content.additionalMessage === 'string') {
					disclaimers.textContent = content.additionalMessage;
				} else {
					const additionalMessageResult = this.renderMarkdownMessageContent(content.additionalMessage, options);
					disclaimers.appendChild(additionalMessageResult.element);
				}
			}

			// Render suggested prompts for both new user and regular modes
			if (content.suggestedPrompts && content.suggestedPrompts.length) {
				const suggestedPromptsContainer = dom.append(this.element, $('.chat-welcome-view-suggested-prompts'));
				const titleElement = dom.append(suggestedPromptsContainer, $('.chat-welcome-view-suggested-prompts-title'));
				titleElement.textContent = localize('chatWidget.suggestedActions', 'Suggested Actions');

				for (const prompt of content.suggestedPrompts) {
					const promptElement = dom.append(suggestedPromptsContainer, $('.chat-welcome-view-suggested-prompt'));
					// Make the prompt element keyboard accessible
					promptElement.setAttribute('role', 'button');
					promptElement.setAttribute('tabindex', '0');
					const promptAriaLabel = prompt.description
						? localize('suggestedPromptAriaLabelWithDescription', 'Suggested prompt: {0}, {1}', prompt.label, prompt.description)
						: localize('suggestedPromptAriaLabel', 'Suggested prompt: {0}', prompt.label);
					promptElement.setAttribute('aria-label', promptAriaLabel);
					const titleElement = dom.append(promptElement, $('.chat-welcome-view-suggested-prompt-title'));
					titleElement.textContent = prompt.label;
					const tooltip = localize('runPromptTitle', "Suggested prompt: {0}", prompt.prompt);
					promptElement.title = tooltip;
					titleElement.title = tooltip;
					if (prompt.description) {
						const descriptionElement = dom.append(promptElement, $('.chat-welcome-view-suggested-prompt-description'));
						descriptionElement.textContent = prompt.description;
						descriptionElement.title = prompt.description;
					}
					const executePrompt = () => {
						type SuggestedPromptClickEvent = { suggestedPrompt: string };

						type SuggestedPromptClickData = {
							owner: 'bhavyaus';
							comment: 'Event used to gain insights into when suggested prompts are clicked.';
							suggestedPrompt: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The suggested prompt clicked.' };
						};

						this.telemetryService.publicLog2<SuggestedPromptClickEvent, SuggestedPromptClickData>('chat.clickedSuggestedPrompt', {
							suggestedPrompt: prompt.prompt,
						});

						if (!this.chatWidgetService.lastFocusedWidget) {
							const widgets = this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat);
							if (widgets.length) {
								widgets[0].setInput(prompt.prompt);
							}
						} else {
							this.chatWidgetService.lastFocusedWidget.setInput(prompt.prompt);
						}
					};
					// Add context menu handler
					this._register(dom.addDisposableListener(promptElement, dom.EventType.CONTEXT_MENU, (e: MouseEvent) => {
						e.preventDefault();
						e.stopImmediatePropagation();

						const actions = this.getPromptContextMenuActions(prompt);

						this.contextMenuService.showContextMenu({
							getAnchor: () => ({ x: e.clientX, y: e.clientY }),
							getActions: () => actions,
						});
					}));
					// Add click handler
					this._register(dom.addDisposableListener(promptElement, dom.EventType.CLICK, executePrompt));
					// Add keyboard handler
					this._register(dom.addDisposableListener(promptElement, dom.EventType.KEY_DOWN, (e) => {
						const event = new StandardKeyboardEvent(e);
						if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
							e.preventDefault();
							e.stopPropagation();
							executePrompt();
						}
						else if (event.equals(KeyCode.F10) && event.shiftKey) {
							e.preventDefault();
							e.stopPropagation();
							const actions = this.getPromptContextMenuActions(prompt);
							this.contextMenuService.showContextMenu({
								getAnchor: () => promptElement,
								getActions: () => actions,
							});
						}
					}));
				}
			}

			// Tips
			if (content.tips) {
				const tips = dom.append(this.element, $('.chat-welcome-view-tips'));
				const tipsResult = this._register(this.markdownRendererService.render(content.tips));
				tips.appendChild(tipsResult.element);
			}
		} catch (err) {
			this.logService.error('Failed to render chat view welcome content', err);
		}
	}

	private getPromptContextMenuActions(prompt: IChatSuggestedPrompts): IAction[] {
		const actions: IAction[] = [];
		if (prompt.uri) {
			const uri = prompt.uri;
			actions.push(new Action(
				'chat.editPromptFile',
				localize('editPromptFile', "Edit Prompt File"),
				ThemeIcon.asClassName(Codicon.goToFile),
				true,
				async () => {
					try {
						await this.openerService.open(uri);
					} catch (error) {
						this.logService.error('Failed to open prompt file:', error);
					}
				}
			));
		}
		return actions;
	}

	public needsRerender(content: IChatViewWelcomeContent): boolean {
		// Heuristic based on content that changes between states
		return !!(
			this.content.title !== content.title ||
			this.content.message.value !== content.message.value ||
			this.content.additionalMessage !== content.additionalMessage ||
			this.content.tips?.value !== content.tips?.value ||
			this.content.suggestedPrompts?.length !== content.suggestedPrompts?.length ||
			this.content.suggestedPrompts?.some((prompt, index) => {
				const incoming = content.suggestedPrompts?.[index];
				return incoming?.label !== prompt.label || incoming?.description !== prompt.description;
			}));
	}

	private renderMarkdownMessageContent(content: IMarkdownString, options: IChatViewWelcomeRenderOptions | undefined): IRenderedMarkdown {
		const messageResult = this._register(this.markdownRendererService.render(content));
		// eslint-disable-next-line no-restricted-syntax
		const firstLink = options?.firstLinkToButton ? messageResult.element.querySelector('a') : undefined;
		if (firstLink) {
			const target = firstLink.getAttribute('data-href');
			const button = this._register(new Button(firstLink.parentElement!, defaultButtonStyles));
			button.label = firstLink.textContent ?? '';
			if (target) {
				this._register(button.onDidClick(() => {
					this.openerService.open(target, { allowCommands: true });
				}));
			}
			firstLink.replaceWith(button.element);
		}
		return messageResult;
	}
}

/**
 * STACKCODE: Custom login form rendered inline in the chat welcome area.
 * Displays Client ID, Client Key, Realm fields + "Connect and Continue" button
 * matching the StackSpot AI branding design.
 */
class StackCodeLoginPart extends Disposable {
	public readonly element: HTMLElement;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.element = dom.$('.stackcode-login-view');

		try {
			// Logo (orange dots grid pattern — built with DOM API for CSP compliance)
			const logoContainer = dom.append(this.element, $('.stackcode-login-logo'));
			const svgNS = 'http://www.w3.org/2000/svg';
			const svg = document.createElementNS(svgNS, 'svg');
			svg.setAttribute('width', '64');
			svg.setAttribute('height', '64');
			svg.setAttribute('viewBox', '0 0 64 64');
			svg.setAttribute('fill', 'none');

			const circlePositions = [
				[32, 8], [20, 14], [32, 20], [44, 14],
				[14, 26], [26, 26], [38, 26], [50, 26],
				[8, 38], [20, 38], [32, 38], [44, 38], [56, 38],
				[14, 50], [26, 50], [38, 50], [50, 50],
				[20, 56], [32, 56], [44, 56],
			];
			for (const [cx, cy] of circlePositions) {
				const circle = document.createElementNS(svgNS, 'circle');
				circle.setAttribute('cx', String(cx));
				circle.setAttribute('cy', String(cy));
				circle.setAttribute('r', '4');
				circle.setAttribute('fill', '#E8732A');
				svg.appendChild(circle);
			}
			logoContainer.appendChild(svg);

			// Title
			const title = dom.append(this.element, $('.stackcode-login-title'));
			title.textContent = 'StackSpot AI';

			// Subtitle
			const subtitle = dom.append(this.element, $('.stackcode-login-subtitle'));
			subtitle.textContent = 'Enter your credentials to connect to StackSpot AI.';

			// Form container
			const form = dom.append(this.element, $('.stackcode-login-form'));

			// Client ID field
			const clientIdGroup = dom.append(form, $('.stackcode-login-field'));
			const clientIdLabel = dom.append(clientIdGroup, $('label.stackcode-login-label'));
			clientIdLabel.textContent = 'Client ID';
			const clientIdInput = dom.append(clientIdGroup, $('input.stackcode-login-input')) as HTMLInputElement;
			clientIdInput.type = 'text';
			clientIdInput.placeholder = 'Enter your Client ID';
			clientIdInput.autocomplete = 'off';
			clientIdInput.spellcheck = false;

			// Client Key field
			const clientKeyGroup = dom.append(form, $('.stackcode-login-field'));
			const clientKeyLabel = dom.append(clientKeyGroup, $('label.stackcode-login-label'));
			clientKeyLabel.textContent = 'Client Key';
			const clientKeyInput = dom.append(clientKeyGroup, $('input.stackcode-login-input')) as HTMLInputElement;
			clientKeyInput.type = 'password';
			clientKeyInput.placeholder = 'Enter your Client Key';
			clientKeyInput.autocomplete = 'off';

			// Realm field
			const realmGroup = dom.append(form, $('.stackcode-login-field'));
			const realmLabel = dom.append(realmGroup, $('label.stackcode-login-label'));
			realmLabel.textContent = 'Realm';
			const realmInput = dom.append(realmGroup, $('input.stackcode-login-input')) as HTMLInputElement;
			realmInput.type = 'text';
			realmInput.placeholder = 'e.g. my-company';
			realmInput.autocomplete = 'off';
			realmInput.spellcheck = false;

			// Error message container (hidden by default)
			const errorContainer = dom.append(form, $('.stackcode-login-error'));
			errorContainer.style.display = 'none';

			// Connect button
			const buttonContainer = dom.append(form, $('.stackcode-login-button-container'));
			const connectButton = dom.append(buttonContainer, $('button.stackcode-login-button')) as HTMLButtonElement;
			connectButton.textContent = 'Connect and Continue';
			connectButton.type = 'button';

			// Security notice
			const notice = dom.append(this.element, $('.stackcode-login-notice'));
			notice.textContent = 'Your credentials are stored securely in the application.';

			// Form submission handler
			const doLogin = async () => {
				console.log('[stackcode-ui] doLogin called');
				const realm = realmInput.value.trim();
				const clientId = clientIdInput.value.trim();
				const clientKey = clientKeyInput.value.trim();

				// Validation
				if (!clientId) {
					errorContainer.textContent = 'Client ID is required.';
					errorContainer.style.display = 'block';
					clientIdInput.focus();
					return;
				}
				if (!clientKey) {
					errorContainer.textContent = 'Client Key is required.';
					errorContainer.style.display = 'block';
					clientKeyInput.focus();
					return;
				}
				if (!realm) {
					errorContainer.textContent = 'Realm is required.';
					errorContainer.style.display = 'block';
					realmInput.focus();
					return;
				}

				// Clear error
				errorContainer.style.display = 'none';

				// Disable form during login
				connectButton.disabled = true;
				connectButton.textContent = 'Connecting...';
				clientIdInput.disabled = true;
				clientKeyInput.disabled = true;
				realmInput.disabled = true;

				try {
					console.log('[stackcode-ui] About to executeCommand stackcode.login with realm:', realm);
					await this.commandService.executeCommand('stackcode.login', {
						realm,
						clientId,
						clientKey,
					});
					console.log('[stackcode-ui] executeCommand completed successfully');
				} catch (err) {
					console.error('[stackcode-ui] executeCommand failed:', err);
					this.logService.error('StackCode login failed', err);
					errorContainer.textContent = err instanceof Error ? err.message : 'Connection failed. Please check your credentials.';
					errorContainer.style.display = 'block';
				} finally {
					// Re-enable form
					connectButton.disabled = false;
					connectButton.textContent = 'Connect and Continue';
					clientIdInput.disabled = false;
					clientKeyInput.disabled = false;
					realmInput.disabled = false;
				}
			};

			// Click handler
			this._register(dom.addDisposableListener(connectButton, dom.EventType.CLICK, () => {
				doLogin();
			}));

			// Enter key submits form from any input
			const handleEnter = (e: KeyboardEvent) => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter)) {
					e.preventDefault();
					doLogin();
				}
			};
			this._register(dom.addDisposableListener(clientIdInput, dom.EventType.KEY_DOWN, handleEnter));
			this._register(dom.addDisposableListener(clientKeyInput, dom.EventType.KEY_DOWN, handleEnter));
			this._register(dom.addDisposableListener(realmInput, dom.EventType.KEY_DOWN, handleEnter));

		} catch (err) {
			this.logService.error('Failed to render StackCode login view', err);
		}
	}
}
