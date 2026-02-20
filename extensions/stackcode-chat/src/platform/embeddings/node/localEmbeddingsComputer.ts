/*---------------------------------------------------------------------------------------------
 *  STACKCODE: Local ONNX-based embeddings computer.
 *  Replaces RemoteEmbeddingsComputer to prevent data leakage to GitHub/Copilot.
 *  Uses all-MiniLM-L6-v2 (quantized uint8) with ONNX Runtime for local inference.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { CancellationToken } from 'vscode';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { ILogService } from '../../log/common/logService';
import { logExecTime } from '../../log/common/logExecTime';
import {
	ComputeEmbeddingsOptions,
	Embedding,
	EmbeddingType,
	EmbeddingVector,
	Embeddings,
	IEmbeddingsComputer,
} from '../common/embeddingsComputer';

// ─── WordPiece Tokenizer (BertTokenizer) ────────────────────────────────────

const VOCAB_SPECIAL = {
	PAD: '[PAD]',
	UNK: '[UNK]',
	CLS: '[CLS]',
	SEP: '[SEP]',
} as const;

interface TokenizerResult {
	inputIds: BigInt64Array;
	attentionMask: BigInt64Array;
	tokenTypeIds: BigInt64Array;
}

class BertTokenizer {
	private readonly vocab: Map<string, number> = new Map();
	private readonly unkId: number;
	private readonly clsId: number;
	private readonly sepId: number;
	private readonly padId: number;
	private readonly maxLength: number;

	constructor(vocabText: string, maxLength = 512) {
		this.maxLength = maxLength;
		const lines = vocabText.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const token = lines[i];
			if (token.length > 0) {
				this.vocab.set(token, i);
			}
		}
		this.padId = this.vocab.get(VOCAB_SPECIAL.PAD) ?? 0;
		this.unkId = this.vocab.get(VOCAB_SPECIAL.UNK) ?? 100;
		this.clsId = this.vocab.get(VOCAB_SPECIAL.CLS) ?? 101;
		this.sepId = this.vocab.get(VOCAB_SPECIAL.SEP) ?? 102;
	}

	/**
	 * Tokenize a batch of strings into padded tensors ready for ONNX inference.
	 */
	public tokenizeBatch(texts: readonly string[]): TokenizerResult[] {
		return texts.map(text => this.tokenize(text));
	}

	/**
	 * Tokenize a single string. Returns [CLS] + wordpiece tokens + [SEP], padded to maxLength.
	 */
	private tokenize(text: string): TokenizerResult {
		// BertTokenizer: lowercase, basic tokenize, then wordpiece
		const normalized = text.toLowerCase();
		const basicTokens = this.basicTokenize(normalized);

		const wpTokenIds: number[] = [this.clsId];
		for (const token of basicTokens) {
			if (wpTokenIds.length >= this.maxLength - 1) {
				break;
			}
			const subTokenIds = this.wordPieceTokenize(token);
			for (const id of subTokenIds) {
				if (wpTokenIds.length >= this.maxLength - 1) {
					break;
				}
				wpTokenIds.push(id);
			}
		}
		wpTokenIds.push(this.sepId);

		const seqLen = this.maxLength;
		const inputIds = new BigInt64Array(seqLen);
		const attentionMask = new BigInt64Array(seqLen);
		const tokenTypeIds = new BigInt64Array(seqLen);

		for (let i = 0; i < wpTokenIds.length; i++) {
			inputIds[i] = BigInt(wpTokenIds[i]);
			attentionMask[i] = 1n;
			// tokenTypeIds stays 0 (single segment)
		}
		// Remaining positions: inputIds = padId, attentionMask = 0, tokenTypeIds = 0
		for (let i = wpTokenIds.length; i < seqLen; i++) {
			inputIds[i] = BigInt(this.padId);
			// attentionMask and tokenTypeIds already 0
		}

		return { inputIds, attentionMask, tokenTypeIds };
	}

	/**
	 * Basic tokenization: split on whitespace and punctuation, strip accents.
	 */
	private basicTokenize(text: string): string[] {
		const tokens: string[] = [];
		let current = '';

		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (this.isWhitespace(ch)) {
				if (current.length > 0) {
					tokens.push(current);
					current = '';
				}
			} else if (this.isPunctuation(ch)) {
				if (current.length > 0) {
					tokens.push(current);
					current = '';
				}
				tokens.push(ch);
			} else {
				current += ch;
			}
		}
		if (current.length > 0) {
			tokens.push(current);
		}
		return tokens;
	}

	/**
	 * WordPiece tokenization: greedy longest-match-first on each word.
	 */
	private wordPieceTokenize(word: string): number[] {
		if (word.length === 0) {
			return [];
		}

		const ids: number[] = [];
		let start = 0;

		while (start < word.length) {
			let end = word.length;
			let foundId: number | undefined;

			while (start < end) {
				const substr = start === 0 ? word.slice(start, end) : '##' + word.slice(start, end);
				const id = this.vocab.get(substr);
				if (id !== undefined) {
					foundId = id;
					break;
				}
				end--;
			}

			if (foundId === undefined) {
				// Character not in vocab — map to [UNK]
				ids.push(this.unkId);
				start++;
			} else {
				ids.push(foundId);
				start = end;
			}
		}

		return ids;
	}

	private isWhitespace(ch: string): boolean {
		return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
	}

	private isPunctuation(ch: string): boolean {
		const code = ch.charCodeAt(0);
		// ASCII punctuation ranges: 33-47, 58-64, 91-96, 123-126
		return (code >= 33 && code <= 47) ||
			(code >= 58 && code <= 64) ||
			(code >= 91 && code <= 96) ||
			(code >= 123 && code <= 126);
	}
}

// ─── Local Embeddings Computer ──────────────────────────────────────────────

/** Local embedding type: all-MiniLM-L6-v2 produces 384-dimensional float32 vectors */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

export class LocalEmbeddingsComputer implements IEmbeddingsComputer {

	declare readonly _serviceBrand: undefined;

	private _tokenizer: BertTokenizer | undefined;
	private _session: any | undefined; // onnxruntime-node InferenceSession
	private _initPromise: Promise<void> | undefined;
	private _ort: any; // onnxruntime-node module

	private readonly batchSize = 32; // Process at most 32 inputs per ONNX inference call

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	public async computeEmbeddings(
		embeddingType: EmbeddingType,
		inputs: readonly string[],
		_options?: ComputeEmbeddingsOptions,
		_telemetryInfo?: TelemetryCorrelationId,
		token?: CancellationToken,
	): Promise<Embeddings> {
		return logExecTime(this._logService, 'LocalEmbeddingsComputer::computeEmbeddings', async () => {
			await this._ensureInitialized();

			if (inputs.length === 0) {
				return { type: embeddingType, values: [] };
			}

			const allEmbeddings: Embedding[] = [];

			for (let i = 0; i < inputs.length; i += this.batchSize) {
				if (token?.isCancellationRequested) {
					return { type: embeddingType, values: [] };
				}

				const batch = inputs.slice(i, i + this.batchSize);
				const batchVectors = await this._inferBatch(batch);

				for (const vec of batchVectors) {
					allEmbeddings.push({ type: embeddingType, value: vec });
				}
			}

			return { type: embeddingType, values: allEmbeddings };
		});
	}

	// ─── Initialization ─────────────────────────────────────────────────

	private async _ensureInitialized(): Promise<void> {
		if (this._session && this._tokenizer) {
			return;
		}
		if (!this._initPromise) {
			this._initPromise = this._initialize().catch(err => {
				// STACKCODE: Reset initPromise so retry is possible on next call
				this._initPromise = undefined;
				this._logService.error(`[LocalEmbeddingsComputer] Initialization FAILED (will retry on next call): ${err}`);
				if (err instanceof Error && err.stack) {
					this._logService.error(`[LocalEmbeddingsComputer] Stack: ${err.stack}`);
				}
				throw err;
			});
		}
		return this._initPromise;
	}

	private async _initialize(): Promise<void> {
		const modelDir = this._getModelDir();
		this._logService.info(`[LocalEmbeddingsComputer] Initializing from ${modelDir}`);

		// Load vocab
		let fs: typeof import('fs');
		try {
			fs = await import('fs');
		} catch (e) {
			this._logService.error(`[LocalEmbeddingsComputer] Failed to import 'fs': ${e}`);
			throw e;
		}

		const vocabPath = path.join(modelDir, 'vocab.txt');
		this._logService.info(`[LocalEmbeddingsComputer] Loading vocab from: ${vocabPath}`);

		// Verify model files exist
		if (!fs.existsSync(vocabPath)) {
			const err = new Error(`[LocalEmbeddingsComputer] vocab.txt not found at: ${vocabPath}`);
			this._logService.error(err.message);
			throw err;
		}

		const modelPath = path.join(modelDir, 'model.onnx');
		if (!fs.existsSync(modelPath)) {
			const err = new Error(`[LocalEmbeddingsComputer] model.onnx not found at: ${modelPath}`);
			this._logService.error(err.message);
			throw err;
		}

		this._logService.info(`[LocalEmbeddingsComputer] Model files verified. vocab=${vocabPath}, model=${modelPath}`);

		const vocabText = fs.readFileSync(vocabPath, 'utf-8');
		this._tokenizer = new BertTokenizer(vocabText, 512);
		this._logService.info(`[LocalEmbeddingsComputer] Tokenizer loaded (vocab size: ${vocabText.split('\\n').length})`);

		// Load ONNX model
		this._logService.info(`[LocalEmbeddingsComputer] Loading onnxruntime-node...`);
		try {
			this._ort = await import('onnxruntime-node');
		} catch (e) {
			this._logService.error(`[LocalEmbeddingsComputer] Failed to import onnxruntime-node: ${e}`);
			if (e instanceof Error && e.stack) {
				this._logService.error(`[LocalEmbeddingsComputer] onnxruntime-node import stack: ${e.stack}`);
			}
			throw e;
		}

		this._logService.info(`[LocalEmbeddingsComputer] onnxruntime-node imported. Creating InferenceSession for: ${modelPath}`);
		try {
			this._session = await this._ort.InferenceSession.create(modelPath, {
				executionProviders: ['cpu'],
				graphOptimizationLevel: 'all',
			});
		} catch (e) {
			this._logService.error(`[LocalEmbeddingsComputer] Failed to create InferenceSession: ${e}`);
			if (e instanceof Error && e.stack) {
				this._logService.error(`[LocalEmbeddingsComputer] InferenceSession stack: ${e.stack}`);
			}
			throw e;
		}

		this._logService.info('[LocalEmbeddingsComputer] ONNX model loaded successfully');
	}

	/**
	 * Resolve path to the model directory.
	 * In dev mode: extensions/stackcode-chat/models/all-MiniLM-L6-v2
	 * In prod mode: the extension is bundled, so we resolve relative to __dirname (dist/)
	 */
	private _getModelDir(): string {
		// __dirname in esbuild bundle = extensions/stackcode-chat/dist
		// Model files are at: extensions/stackcode-chat/models/all-MiniLM-L6-v2
		return path.resolve(__dirname, '..', 'models', 'all-MiniLM-L6-v2');
	}

	// ─── Inference ──────────────────────────────────────────────────────

	private async _inferBatch(texts: readonly string[]): Promise<EmbeddingVector[]> {
		const tokenizer = this._tokenizer!;
		const session = this._session!;
		const ort = this._ort;

		const tokenized = tokenizer.tokenizeBatch(texts);
		const seqLen = 512;
		const batchLen = texts.length;

		// Flatten into single tensors for batched inference
		const flatInputIds = new BigInt64Array(batchLen * seqLen);
		const flatAttentionMask = new BigInt64Array(batchLen * seqLen);
		const flatTokenTypeIds = new BigInt64Array(batchLen * seqLen);

		for (let b = 0; b < batchLen; b++) {
			const offset = b * seqLen;
			flatInputIds.set(tokenized[b].inputIds, offset);
			flatAttentionMask.set(tokenized[b].attentionMask, offset);
			flatTokenTypeIds.set(tokenized[b].tokenTypeIds, offset);
		}

		const feeds: Record<string, any> = {
			input_ids: new ort.Tensor('int64', flatInputIds, [batchLen, seqLen]),
			attention_mask: new ort.Tensor('int64', flatAttentionMask, [batchLen, seqLen]),
			token_type_ids: new ort.Tensor('int64', flatTokenTypeIds, [batchLen, seqLen]),
		};

		const results = await session.run(feeds);

		// Output: last_hidden_state shape [batch, seqLen, 384]
		const lastHiddenState = results['last_hidden_state'];
		const data: Float32Array = lastHiddenState.data;
		const hiddenSize = LOCAL_EMBEDDING_DIMENSIONS;

		const embeddings: EmbeddingVector[] = [];
		for (let b = 0; b < batchLen; b++) {
			// Mean pooling with attention_mask
			const vec = new Float64Array(hiddenSize);
			let tokenCount = 0;

			for (let t = 0; t < seqLen; t++) {
				if (flatAttentionMask[b * seqLen + t] === 0n) {
					continue; // Skip padding tokens
				}
				tokenCount++;
				const baseIdx = (b * seqLen + t) * hiddenSize;
				for (let h = 0; h < hiddenSize; h++) {
					vec[h] += data[baseIdx + h];
				}
			}

			// Divide by token count
			if (tokenCount > 0) {
				for (let h = 0; h < hiddenSize; h++) {
					vec[h] /= tokenCount;
				}
			}

			// L2 normalize
			let norm = 0;
			for (let h = 0; h < hiddenSize; h++) {
				norm += vec[h] * vec[h];
			}
			norm = Math.sqrt(norm);
			if (norm > 0) {
				for (let h = 0; h < hiddenSize; h++) {
					vec[h] /= norm;
				}
			}

			// Convert to number[] for the EmbeddingVector type
			const result: number[] = new Array(hiddenSize);
			for (let h = 0; h < hiddenSize; h++) {
				result[h] = vec[h];
			}
			embeddings.push(result);
		}

		return embeddings;
	}
}
