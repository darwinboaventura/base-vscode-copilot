/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyMod, KeyCode, KeyChord } from '../../../../base/common/keyCodes.js';

// Cmd+Numpad4 → Toggle Sidebar
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.action.toggleSidebarVisibility',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyMod.CtrlCmd | KeyCode.Numpad4 },
});

// Cmd+Numpad6 → Toggle Auxiliary Bar
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.action.toggleAuxiliaryBar',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyMod.CtrlCmd | KeyCode.Numpad6 },
});

// Shift+Cmd+Numpad6 → Toggle Maximized Auxiliary Bar
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.action.toggleMaximizedAuxiliaryBar',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyMod.Shift | KeyMod.CtrlCmd | KeyCode.Numpad6 },
});

// Cmd+Numpad2 → Toggle Panel
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.action.togglePanel',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyMod.CtrlCmd | KeyCode.Numpad2 },
});

// Shift+Cmd+Numpad2 → Toggle Maximized Panel
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.action.toggleMaximizedPanel',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyMod.Shift | KeyMod.CtrlCmd | KeyCode.Numpad2 },
});

// Cmd+Numpad8 → Simple Browser
KeybindingsRegistry.registerKeybindingRule({
	id: 'simpleBrowser.show',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyMod.CtrlCmd | KeyCode.Numpad8 },
});

// Cmd+I Cmd+P → New Untitled Prompt
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.command.new.untitled.prompt',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyI, KeyMod.CtrlCmd | KeyCode.KeyP) },
});

// Cmd+I Cmd+I → New Instructions
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.command.new.instructions',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyI, KeyMod.CtrlCmd | KeyCode.KeyI) },
});

// Cmd+Numpad5 → Toggle Agent Sessions Sidebar
KeybindingsRegistry.registerKeybindingRule({
	id: 'agentSessions.toggleAgentSessionsSidebar',
	weight: KeybindingWeight.WorkbenchContrib,
	when: undefined,
	mac: { primary: KeyMod.CtrlCmd | KeyCode.Numpad5 },
});

// Shift+Enter in terminal → send newline
KeybindingsRegistry.registerKeybindingRule({
	id: 'workbench.action.terminal.sendSequence',
	weight: KeybindingWeight.WorkbenchContrib,
	when: ContextKeyExpr.has('terminalFocus'),
	args: { text: '\n' },
	mac: { primary: KeyMod.Shift | KeyCode.Enter },
});
