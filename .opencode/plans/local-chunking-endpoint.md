# Plan: Implement LocalChunkingEndpointClient

## Summary
Replace GitHub's remote chunking API (`ChunkingEndpointClientImpl`) with a fully local implementation that uses `NaiveChunker` (token-based line splitting) + `LocalEmbeddingsComputer` (ONNX MiniLM-L6-v2). This makes `EmbeddingsChunkSearch`, `TfIdfWithSemanticChunkSearch`, and `UrlChunkEmbeddingsIndex` work 100% offline.

## Files to Create

### 1. `extensions/stackcode-chat/src/platform/chunking/node/localChunkingEndpointClient.ts`

New file implementing `IChunkingEndpointClient`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  STACKCODE: Local chunking endpoint client.
 *  Replaces ChunkingEndpointClientImpl to avoid HTTP calls to GitHub's chunking API.
 *  Uses NaiveChunker (token-based line splitting) + local ONNX embeddings (all-MiniLM-L6-v2).
 *--------------------------------------------------------------------------------------------*/

import { createSha256Hash } from '../../../util/common/crypto';
import { CallTracker } from '../../../util/common/telemetryCorrelationId';
import { TokenizerType } from '../../../util/common/tokenizer';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { isFalsyOrWhitespace } from '../../../util/vs/base/common/strings';
import { Embedding, EmbeddingType, IEmbeddingsComputer } from '../../embeddings/common/embeddingsComputer';
import { ILogService } from '../../log/common/logService';
import { ITokenizerProvider, TokenizationEndpoint } from '../../tokenizer/node/tokenizer';
import { FileChunkWithEmbedding, FileChunkWithOptionalEmbedding } from '../common/chunk';
import { ChunkableContent, ComputeBatchInfo, EmbeddingsComputeQos, IChunkingEndpointClient } from '../common/chunkingEndpointClient';
import { NaiveChunker } from './naiveChunker';

const defaultTokenizationEndpoint: TokenizationEndpoint = {
	tokenizer: TokenizerType.O200K,
};

export class LocalChunkingEndpointClient implements IChunkingEndpointClient {
	declare readonly _serviceBrand: undefined;

	private _naiveChunker: NaiveChunker | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@ITokenizerProvider private readonly _tokenizerProvider: ITokenizerProvider,
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
	) { }

	private _getNaiveChunker(): NaiveChunker {
		if (!this._naiveChunker) {
			this._naiveChunker = new NaiveChunker(defaultTokenizationEndpoint, this._tokenizerProvider);
		}
		return this._naiveChunker;
	}

	public async computeChunks(
		_authToken: string,
		_embeddingType: EmbeddingType,
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		_qos: EmbeddingsComputeQos,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		_telemetryInfo: CallTracker,
		token: CancellationToken,
	): Promise<readonly FileChunkWithOptionalEmbedding[] | undefined> {
		return this._doComputeChunks(content, batchInfo, cache, token);
	}

	public async computeChunksAndEmbeddings(
		_authToken: string,
		embeddingType: EmbeddingType,
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		_qos: EmbeddingsComputeQos,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		_telemetryInfo: CallTracker,
		token: CancellationToken,
	): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		const chunks = await this._doComputeChunks(content, batchInfo, cache, token);
		if (!chunks || chunks.length === 0) {
			return chunks as FileChunkWithEmbedding[] | undefined;
		}

		const chunkTexts = chunks.map(c => c.chunk.text);
		try {
			const embeddings = await raceCancellationError(
				this._embeddingsComputer.computeEmbeddings(embeddingType, chunkTexts, { inputType: 'document' }, undefined, token),
				token,
			);

			const result: FileChunkWithEmbedding[] = [];
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				const embedding: Embedding | undefined = embeddings.values[i];
				if (!embedding) {
					this._logService.debug(`LocalChunkingEndpointClient: No embedding for chunk ${i} of ${content.uri}`);
					continue;
				}
				result.push({
					chunk: chunk.chunk,
					chunkHash: chunk.chunkHash,
					embedding,
				});
			}
			return result;
		} catch (e) {
			this._logService.error(`LocalChunkingEndpointClient: Failed to compute embeddings for ${content.uri}: ${e}`);
			return undefined;
		}
	}

	private async _doComputeChunks(
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		token: CancellationToken,
	): Promise<readonly FileChunkWithOptionalEmbedding[] | undefined> {
		const text = await raceCancellationError(content.getText(), token);
		if (isFalsyOrWhitespace(text)) {
			return [];
		}

		try {
			batchInfo.recomputedFileCount++;
			batchInfo.sentContentTextLength += text.length;

			const chunker = this._getNaiveChunker();
			const fileChunks = await raceCancellationError(
				chunker.chunkFile(content.uri, text, {}, token),
				token,
			);

			if (!fileChunks || fileChunks.length === 0) {
				return [];
			}

			const result: FileChunkWithOptionalEmbedding[] = [];
			for (const chunk of fileChunks) {
				const chunkHash = await createSha256Hash(chunk.text);

				if (cache) {
					const cached = cache.get(chunkHash);
					if (cached) {
						result.push({
							chunk: {
								file: content.uri,
								text: chunk.text,
								rawText: chunk.rawText,
								range: chunk.range,
								isFullFile: chunk.isFullFile,
							},
							chunkHash,
							embedding: cached.embedding,
						});
						continue;
					}
				}

				result.push({
					chunk: {
						file: content.uri,
						text: chunk.text,
						rawText: chunk.rawText,
						range: chunk.range,
						isFullFile: chunk.isFullFile,
					},
					chunkHash,
					embedding: undefined,
				});
			}
			return result;
		} catch (e) {
			this._logService.error(`LocalChunkingEndpointClient: Error chunking ${content.uri}: ${e}`);
			return undefined;
		}
	}
}
```

## Files to Modify

### 2. `extensions/stackcode-chat/src/extension/extension/vscode-node/services.ts`

**Line 21** — Change import:
```typescript
// BEFORE:
import { ChunkingEndpointClientImpl } from '../../../platform/chunking/common/chunkingEndpointClientImpl';
// AFTER:
import { LocalChunkingEndpointClient } from '../../../platform/chunking/node/localChunkingEndpointClient';
```

**Line 215** — Change registration:
```typescript
// BEFORE:
builder.define(IChunkingEndpointClient, new SyncDescriptor(ChunkingEndpointClientImpl));
// AFTER:
// STACKCODE: Use LocalChunkingEndpointClient — all chunking + embeddings computed locally via NaiveChunker + ONNX
builder.define(IChunkingEndpointClient, new SyncDescriptor(LocalChunkingEndpointClient));
```

## Steps

1. Create `localChunkingEndpointClient.ts`
2. Update `services.ts` import and registration
3. Run `node .esbuild.ts --dev` from `extensions/stackcode-chat/`
4. Launch StackCode and test:
   - Web Fetch tool (no GitHub popup)
   - #codebase search (should now use embeddings instead of falling back to TF-IDF)
   - Workspace indexing (should build embeddings index on startup)

## Risk Assessment

- **Low risk**: The interface contract is preserved exactly. Only the implementation changes.
- **Quality trade-off**: NaiveChunker produces less precise chunk boundaries than GitHub's AST-based chunker. However, the local embeddings compensate by enabling semantic similarity search that was previously unavailable.
- **Performance**: Local ONNX inference is slower than a remote API call for large workspaces, but it's reliable and offline.
