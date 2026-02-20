/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import type { IAbortSignal } from '../networking';
import {
	createErrorResponse,
	FormattedSnippyError,
} from './errorCreator';

type Config<Req> = { method: 'GET' } | { method: 'POST'; body: Req };
type SnippyResponse<Res> = ({ kind: 'success' } & Res) | FormattedSnippyError;

export async function call<Res, Req = unknown>(
	_accessor: ServicesAccessor,
	_endpoint: string,
	_config: Config<Req>,
	_signal?: IAbortSignal
): Promise<SnippyResponse<Res>> {
	// STACKCODE: Snippy/origin-tracker neutralized — no requests to GitHub servers.
	return createErrorResponse(601, 'STACKCODE: Public code matching service is disabled.');
}
