/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import { type IExtensionManifest, parseApiProposalsFromSource, checkExtensionCompatibility, areAllowlistedApiProposalsMatching } from './versionCompatibility.ts';

const root = path.dirname(path.dirname(path.dirname(import.meta.dirname)));

function loadLocalExtensionManifest(): IExtensionManifest {
	// StackCode: Load the manifest from the bundled stackcode-chat extension
	// instead of fetching from the marketplace.
	const manifestPath = path.join(root, 'extensions/stackcode-chat/package.json');
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Built-in extension manifest not found at ${manifestPath}`);
	}
	return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as IExtensionManifest;
}

export async function checkCopilotChatCompatibility(): Promise<void> {
	const extensionId = 'github.copilot-chat';

	console.log(`Checking compatibility of ${extensionId} (using local stackcode-chat extension)...`);

	// Get product version from package.json
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const productVersion = packageJson.version;

	console.log(`Product version: ${productVersion}`);

	// Get API proposals from the generated file
	const apiProposalsPath = path.join(root, 'src/vs/platform/extensions/common/extensionsApiProposals.ts');
	const apiProposalsContent = fs.readFileSync(apiProposalsPath, 'utf8');
	const allApiProposals = parseApiProposalsFromSource(apiProposalsContent);

	const proposalCount = Object.keys(allApiProposals).length;
	if (proposalCount === 0) {
		throw new Error('Failed to load API proposals from source');
	}

	console.log(`Loaded ${proposalCount} API proposals from source`);

	// Load product.json to check allowlisted API proposals
	const productJsonPath = path.join(root, 'product.json');
	let productJson;
	try {
		productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
	} catch (error) {
		throw new Error(`Failed to load or parse product.json: ${error}`);
	}
	const extensionEnabledApiProposals = productJson?.extensionEnabledApiProposals;
	const extensionIdKey = extensionEnabledApiProposals ? Object.keys(extensionEnabledApiProposals).find(key => key.toLowerCase() === extensionId.toLowerCase()) : undefined;
	const productAllowlistedProposals = extensionIdKey ? extensionEnabledApiProposals[extensionIdKey] : undefined;

	if (productAllowlistedProposals) {
		console.log(`Product.json allowlisted proposals for ${extensionId}:`);
		for (const proposal of productAllowlistedProposals) {
			console.log(`    ${proposal}`);
		}
	} else {
		console.log(`Product.json allowlisted proposals for ${extensionId}: none`);
	}

	// Load the local stackcode-chat extension manifest instead of fetching from marketplace
	const manifest = loadLocalExtensionManifest();

	console.log(`Extension ${extensionId}@${manifest.version} (local):`);
	console.log(`  engines.vscode: ${manifest.engines.vscode}`);
	console.log(`  enabledApiProposals:\n    ${manifest.enabledApiProposals?.join('\n    ') || 'none'}`);

	// Check compatibility
	const result = checkExtensionCompatibility(productVersion, allApiProposals, manifest);
	if (!result.compatible) {
		throw new Error(`Compatibility check failed:\n  ${result.errors.join('\n  ')}`);
	}

	console.log(`  ✓ Engine version compatible`);
	if (manifest.enabledApiProposals?.length) {
		console.log(`  ✓ API proposals compatible`);
	}

	// Check that product.json allowlist matches package.json declarations
	const allowlistResult = areAllowlistedApiProposalsMatching(extensionId, productAllowlistedProposals, manifest.enabledApiProposals);
	if (!allowlistResult.compatible) {
		throw new Error(`Allowlist check failed:\n  ${allowlistResult.errors.join('\n  ')}`);
	}

	console.log(`  ✓ Product.json allowlist matches package.json`);
	console.log(`✓ ${extensionId} is compatible with this build`);
}

if (import.meta.main) {
	const warnOnly = process.argv.includes('--warn-only');

	checkCopilotChatCompatibility().then(() => {
		console.log('Copilot Chat compatibility check passed');
		process.exit(0);
	}, err => {
		if (warnOnly) {
			// Issue a warning using Azure DevOps logging commands but don't fail the build
			console.log(`##vso[task.logissue type=warning]Copilot Chat compatibility check failed: ${err.message}`);
			console.log(`##vso[task.complete result=SucceededWithIssues;]Copilot Chat compatibility check failed`);
			console.log('');
			console.log(`⚠️  WARNING: ${err.message}`);
			console.log('');
			console.log('The build will continue, but the release step will fail if this is not resolved.');
			process.exit(0);
		} else {
			console.error(err);
			process.exit(1);
		}
	});
}
