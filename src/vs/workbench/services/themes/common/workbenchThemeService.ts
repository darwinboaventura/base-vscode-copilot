/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export enum ThemeSettingDefaults {
	COLOR_THEME_DARK = 'StackCode AI',
	COLOR_THEME_LIGHT = 'Default Light Modern',
	COLOR_THEME_HC_DARK = 'Default High Contrast',
	COLOR_THEME_HC_LIGHT = 'Default High Contrast Light',

	COLOR_THEME_DARK_OLD = 'Default Dark+',
	COLOR_THEME_LIGHT_OLD = 'Default Light+',

	FILE_ICON_THEME = 'vs-seti',
	PRODUCT_ICON_THEME = 'Default',
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'activityBar.activeBorder': '#F26D21',
	'activityBar.background': '#1a1a1a',
	'activityBar.border': '#2B2B2B',
	'activityBar.foreground': '#FFFFFF',
	'activityBar.inactiveForeground': '#888888',
	'activityBarBadge.background': '#F26D21',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#F26D21',
	'badge.foreground': '#FFFFFF',
	'button.background': '#F26D21',
	'button.border': '#FFFFFF12',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#D85A15',
	'button.secondaryBackground': '#2B2B2B',
	'button.secondaryForeground': '#CCCCCC',
	'button.secondaryHoverBackground': '#333333',
	'chat.slashCommandBackground': '#F26D2133',
	'chat.slashCommandForeground': '#F26D21',
	'chat.editedFileForeground': '#F26D21',
	'checkbox.background': '#242424',
	'checkbox.border': '#333333',
	'debugToolBar.background': '#1a1a1a',
	'descriptionForeground': '#888888',
	'dropdown.background': '#242424',
	'dropdown.border': '#333333',
	'dropdown.foreground': '#CCCCCC',
	'dropdown.listBackground': '#1a1a1a',
	'editor.background': '#1e1e1e',
	'editor.findMatchBackground': '#F26D2166',
	'editor.foreground': '#CCCCCC',
	'editor.inactiveSelectionBackground': '#333333',
	'editor.selectionHighlightBackground': '#F26D2133',
	'editorGroup.border': '#2B2B2B',
	'editorGroupHeader.tabsBackground': '#1a1a1a',
	'editorGroupHeader.tabsBorder': '#2B2B2B',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#F26D21',
	'editorIndentGuide.activeBackground1': '#555555',
	'editorIndentGuide.background1': '#333333',
	'editorLineNumber.activeForeground': '#CCCCCC',
	'editorLineNumber.foreground': '#555555',
	'editorOverviewRuler.border': '#1e1e1e',
	'editorWidget.background': '#1a1a1a',
	'errorForeground': '#F85149',
	'focusBorder': '#F26D21',
	'foreground': '#CCCCCC',
	'icon.foreground': '#CCCCCC',
	'input.background': '#242424',
	'input.border': '#333333',
	'input.foreground': '#CCCCCC',
	'input.placeholderForeground': '#888888',
	'inputOption.activeBackground': '#F26D2133',
	'inputOption.activeBorder': '#F26D21',
	'keybindingLabel.foreground': '#CCCCCC',
	'list.activeSelectionIconForeground': '#FFFFFF',
	'list.dropBackground': '#F26D2133',
	'menu.background': '#1a1a1a',
	'menu.border': '#333333',
	'menu.foreground': '#CCCCCC',
	'menu.selectionBackground': '#F26D21',
	'menu.separatorBackground': '#333333',
	'notificationCenterHeader.background': '#1a1a1a',
	'notificationCenterHeader.foreground': '#CCCCCC',
	'notifications.background': '#1a1a1a',
	'notifications.border': '#2B2B2B',
	'notifications.foreground': '#CCCCCC',
	'panel.background': '#1a1a1a',
	'panel.border': '#2B2B2B',
	'panelInput.border': '#333333',
	'panelTitle.activeBorder': '#F26D21',
	'panelTitle.activeForeground': '#FFFFFF',
	'panelTitle.inactiveForeground': '#888888',
	'peekViewEditor.background': '#1a1a1a',
	'peekViewEditor.matchHighlightBackground': '#F26D2166',
	'peekViewResult.background': '#1a1a1a',
	'peekViewResult.matchHighlightBackground': '#F26D2166',
	'pickerGroup.border': '#333333',
	'ports.iconRunningProcessForeground': '#2EA043',
	'progressBar.background': '#F26D21',
	'quickInput.background': '#1a1a1a',
	'quickInput.foreground': '#CCCCCC',
	'settings.dropdownBackground': '#242424',
	'settings.dropdownBorder': '#333333',
	'settings.headerForeground': '#FFFFFF',
	'settings.modifiedItemIndicator': '#F26D21',
	'sideBar.background': '#1a1a1a',
	'sideBar.border': '#2B2B2B',
	'sideBar.foreground': '#CCCCCC',
	'sideBarSectionHeader.background': '#1a1a1a',
	'sideBarSectionHeader.border': '#2B2B2B',
	'sideBarSectionHeader.foreground': '#CCCCCC',
	'sideBarTitle.foreground': '#FFFFFF',
	'statusBar.background': '#1a1a1a',
	'statusBar.border': '#2B2B2B',
	'statusBar.debuggingBackground': '#F26D21',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#F26D21',
	'statusBar.foreground': '#CCCCCC',
	'statusBar.noFolderBackground': '#1a1a1a',
	'statusBarItem.focusBorder': '#F26D21',
	'statusBarItem.prominentBackground': '#F26D2133',
	'statusBarItem.remoteBackground': '#F26D21',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#1e1e1e',
	'tab.activeBorder': '#1e1e1e',
	'tab.activeBorderTop': '#F26D21',
	'tab.activeForeground': '#FFFFFF',
	'tab.border': '#2B2B2B',
	'tab.hoverBackground': '#242424',
	'tab.inactiveBackground': '#1a1a1a',
	'tab.inactiveForeground': '#888888',
	'tab.lastPinnedBorder': '#333333',
	'tab.selectedBackground': '#1e1e1e',
	'tab.selectedBorderTop': '#F26D21',
	'tab.selectedForeground': '#FFFFFF',
	'tab.unfocusedActiveBorder': '#1e1e1e',
	'tab.unfocusedActiveBorderTop': '#333333',
	'tab.unfocusedHoverBackground': '#242424',
	'terminal.foreground': '#CCCCCC',
	'terminal.inactiveSelectionBackground': '#333333',
	'terminal.tab.activeBorder': '#F26D21',
	'textBlockQuote.background': '#242424',
	'textBlockQuote.border': '#F26D21',
	'textCodeBlock.background': '#242424',
	'textLink.activeForeground': '#F26D21',
	'textLink.foreground': '#F26D21',
	'textPreformat.background': '#242424',
	'textPreformat.foreground': '#CCCCCC',
	'textSeparator.foreground': '#333333',
	'titleBar.activeBackground': '#1a1a1a',
	'titleBar.activeForeground': '#FFFFFF',
	'titleBar.border': '#2B2B2B',
	'titleBar.inactiveBackground': '#1a1a1a',
	'titleBar.inactiveForeground': '#888888',
	'welcomePage.progress.foreground': '#F26D21',
	'welcomePage.tileBackground': '#242424',
	'widget.border': '#333333'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#005FB8',
	'activityBar.background': '#F8F8F8',
	'activityBar.border': '#E5E5E5',
	'activityBar.foreground': '#1F1F1F',
	'activityBar.inactiveForeground': '#616161',
	'activityBarBadge.background': '#005FB8',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#CCCCCC',
	'badge.foreground': '#3B3B3B',
	'button.background': '#005FB8',
	'button.border': '#0000001a',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#0258A8',
	'button.secondaryBackground': '#E5E5E5',
	'button.secondaryForeground': '#3B3B3B',
	'button.secondaryHoverBackground': '#CCCCCC',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#F8F8F8',
	'checkbox.border': '#CECECE',
	'descriptionForeground': '#3B3B3B',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#CECECE',
	'dropdown.foreground': '#3B3B3B',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#3B3B3B',
	'editor.inactiveSelectionBackground': '#E5EBF1',
	'editor.selectionHighlightBackground': '#ADD6FF80',
	'editorGroup.border': '#E5E5E5',
	'editorGroupHeader.tabsBackground': '#F8F8F8',
	'editorGroupHeader.tabsBorder': '#E5E5E5',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#005FB8',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D3D3D3',
	'editorLineNumber.activeForeground': '#171184',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#E5E5E5',
	'editorSuggestWidget.background': '#F8F8F8',
	'editorWidget.background': '#F8F8F8',
	'errorForeground': '#F85149',
	'focusBorder': '#005FB8',
	'foreground': '#3B3B3B',
	'icon.foreground': '#3B3B3B',
	'input.background': '#FFFFFF',
	'input.border': '#CECECE',
	'input.foreground': '#3B3B3B',
	'input.placeholderForeground': '#767676',
	'inputOption.activeBackground': '#BED6ED',
	'inputOption.activeBorder': '#005FB8',
	'inputOption.activeForeground': '#000000',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#E8E8E8',
	'list.activeSelectionForeground': '#000000',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#005FB8',
	'list.hoverBackground': '#F2F2F2',
	'menu.border': '#CECECE',
	'menu.selectionBackground': '#005FB8',
	'menu.selectionForeground': '#ffffff',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#E5E5E5',
	'notifications.foreground': '#3B3B3B',
	'panel.background': '#F8F8F8',
	'panel.border': '#E5E5E5',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#005FB8',
	'panelTitle.activeForeground': '#3B3B3B',
	'panelTitle.inactiveForeground': '#3B3B3B',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#E5E5E5',
	'pickerGroup.foreground': '#8B949E',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#005FB8',
	'quickInput.background': '#F8F8F8',
	'quickInput.foreground': '#3B3B3B',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F8F8F8',
	'sideBar.border': '#E5E5E5',
	'sideBar.foreground': '#3B3B3B',
	'sideBarSectionHeader.background': '#F8F8F8',
	'sideBarSectionHeader.border': '#E5E5E5',
	'sideBarSectionHeader.foreground': '#3B3B3B',
	'sideBarTitle.foreground': '#3B3B3B',
	'statusBar.background': '#F8F8F8',
	'statusBar.border': '#E5E5E5',
	'statusBar.debuggingBackground': '#FD716C',
	'statusBar.debuggingForeground': '#000000',
	'statusBar.focusBorder': '#005FB8',
	'statusBar.foreground': '#3B3B3B',
	'statusBar.noFolderBackground': '#F8F8F8',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#B8B8B850',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#005FB8',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#F8F8F8',
	'tab.activeBorderTop': '#005FB8',
	'tab.activeForeground': '#3B3B3B',
	'tab.border': '#E5E5E5',
	'tab.hoverBackground': '#FFFFFF',
	'tab.inactiveBackground': '#F8F8F8',
	'tab.inactiveForeground': '#868686',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#3B3B3B',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#005FB8',
	'terminalCursor.foreground': '#005FB8',
	'textBlockQuote.background': '#F8F8F8',
	'textBlockQuote.border': '#E5E5E5',
	'textCodeBlock.background': '#F8F8F8',
	'textLink.activeForeground': '#005FB8',
	'textLink.foreground': '#005FB8',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B3B3B',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#F8F8F8',
	'titleBar.activeForeground': '#1E1E1E',
	'titleBar.border': '#E5E5E5',
	'titleBar.inactiveBackground': '#F8F8F8',
	'titleBar.inactiveForeground': '#8B949E',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#E5E5E5'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
