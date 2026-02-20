/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'chat.agentsControl.clickBehavior': 'focus',
		'chat.agentsControl.enabled': true,
		'chat.agent.maxRequests': 1000,
		'chat.restoreLastPanelSession': true,
		'chat.unifiedAgentsBar.enabled': true,
		'chat.viewSessions.enabled': false,

		'diffEditor.renderSideBySide': false,
		'diffEditor.hideUnchangedRegions.enabled': true,

		'files.autoSave': 'afterDelay',

		'git.showProgress': false,

		'github.copilot.chat.claudeCode.enabled': true,
		'github.copilot.chat.cli.branchSupport.enabled': true,
		'github.copilot.chat.languageContext.typescript.enabled': true,

		'inlineChat.affordance': 'editor',
		'inlineChat.renderMode': 'hover',

		'workbench.editor.restoreEditors': false,
		'workbench.editor.showTabs': 'single',
		'workbench.startupEditor': 'none',
		'workbench.tips.enabled': false,
		'workbench.layoutControl.type': 'toggles',
		'workbench.editor.allowOpenInModalEditor': false,

		'terminal.integrated.defaultProfile.osx': 'bash',
		'chat.tools.terminal.autoReplyToPrompts': false,
		'redhat.telemetry.enabled': false,
		'chat.tools.terminal.outputLocation': 'terminal',
		'editor.wordWrap': 'on',
		'editor.aiStats.enabled': false,
		'chat.editMode.hidden': true,
		'workbench.tree.indent': 20
	},
	donotCache: true
}]);
