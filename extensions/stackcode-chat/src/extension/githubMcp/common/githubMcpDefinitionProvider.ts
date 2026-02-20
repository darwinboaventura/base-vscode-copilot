/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken, McpHttpServerDefinition, McpServerDefinitionProvider } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { Event } from '../../../util/vs/base/common/event';

const EnterpriseURLConfig = 'github-enterprise.uri';

/**
 * STACKCODE: This provider is neutralized. It originally returned api.githubcopilot.com/mcp/
 * as an MCP endpoint, which is not an authorized backend. provideMcpServerDefinitions() now
 * returns an empty array, and resolveMcpServerDefinition() throws.
 *
 * The constructor is kept intact to maintain DI compatibility — it still listens for config
 * and auth changes (which are harmless no-ops since the provider returns nothing).
 */
export class GitHubMcpDefinitionProvider implements McpServerDefinitionProvider<McpHttpServerDefinition> {

	readonly onDidChangeMcpServerDefinitions: Event<void>;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService
	) {
		const configurationEvent = Event.chain(configurationService.onDidChangeConfiguration, $ => $
			.filter(e => {
				if (e.affectsConfiguration(ConfigKey.GitHubMcpToolsets.fullyQualifiedId)) {
					return true;
				}
				if (e.affectsConfiguration(ConfigKey.GitHubMcpReadonly.fullyQualifiedId)) {
					return true;
				}
				if (e.affectsConfiguration(ConfigKey.GitHubMcpLockdown.fullyQualifiedId)) {
					return true;
				}
				if (e.affectsConfiguration(ConfigKey.Shared.AuthProvider.fullyQualifiedId)) {
					return true;
				}
				if (e.affectsConfiguration(EnterpriseURLConfig)) {
					return true;
				}
				return false;
			})
			.map(() => { })
		);
		let havePermissiveToken = !!this.authenticationService.permissiveGitHubSession;
		const authEvent = Event.chain(this.authenticationService.onDidAuthenticationChange, $ => $
			.filter(() => {
				const hadToken = havePermissiveToken;
				havePermissiveToken = !!this.authenticationService.permissiveGitHubSession;
				return hadToken !== havePermissiveToken;
			})
			.map(() => {
				this.logService.debug(`GitHubMcpDefinitionProvider: Permissive GitHub session availability changed: ${havePermissiveToken}`);
			})
		);
		this.onDidChangeMcpServerDefinitions = Event.any(configurationEvent, authEvent);
	}

	// STACKCODE: Neutralized — returns no MCP server definitions.
	provideMcpServerDefinitions(): McpHttpServerDefinition[] {
		return [];
	}

	// STACKCODE: Neutralized — no GitHub MCP server to resolve.
	async resolveMcpServerDefinition(_server: McpHttpServerDefinition, _token: CancellationToken): Promise<McpHttpServerDefinition> {
		throw new Error('GitHub MCP Server is not available in StackCode.');
	}
}
