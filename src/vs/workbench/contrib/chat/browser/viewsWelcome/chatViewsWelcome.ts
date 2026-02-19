/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpression } from '../../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';

export const enum ChatViewsWelcomeExtensions {
	ChatViewsWelcomeRegistry = 'workbench.registry.chat.viewsWelcome',
}

/**
 * Services passed to `inputPartFactory` so the factory can execute commands
 * (e.g. login) without needing full DI.
 */
export interface IChatViewsWelcomeServices {
	readonly commandService: ICommandService;
}

export interface IChatViewsWelcomeDescriptor {
	readonly icon?: ThemeIcon | URI;
	readonly title: string;
	readonly content: IMarkdownString;
	readonly when: ContextKeyExpression;
	/**
	 * Optional factory that creates a custom DOM element (e.g. a login form)
	 * to be rendered below the welcome message.
	 */
	readonly inputPartFactory?: (store: DisposableStore, services: IChatViewsWelcomeServices) => HTMLElement;
}

export interface IChatViewsWelcomeContributionRegistry {
	readonly onDidChange: Event<void>;
	get(): ReadonlyArray<IChatViewsWelcomeDescriptor>;
	register(descriptor: IChatViewsWelcomeDescriptor): void;
}

class ChatViewsWelcomeContributionRegistry extends Disposable implements IChatViewsWelcomeContributionRegistry {
	private readonly descriptors: IChatViewsWelcomeDescriptor[] = [];
	private readonly _onDidChange = this._register(new Emitter<void>());
	public readonly onDidChange: Event<void> = this._onDidChange.event;

	public register(descriptor: IChatViewsWelcomeDescriptor): void {
		this.descriptors.push(descriptor);
		this._onDidChange.fire();
	}

	public get(): ReadonlyArray<IChatViewsWelcomeDescriptor> {
		return this.descriptors;
	}
}

export const chatViewsWelcomeRegistry = new ChatViewsWelcomeContributionRegistry();
Registry.add(ChatViewsWelcomeExtensions.ChatViewsWelcomeRegistry, chatViewsWelcomeRegistry);
