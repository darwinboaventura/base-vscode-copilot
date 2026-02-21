# AGENTS.md — StackCode (VS Code Fork)

Instructions for AI coding agents working in this repository.

## Project objective/goal

Completely remove any request/data sent to GitHub Copilot. All AI backend features in this fork must use the extension at `./extensions/stackcode-chat`.

For privacy, legal, and security reasons, this fork will only have one LLM provider, which is permitted and authorized, Stackspot AI. This provider has an API exactly like OpenAI's and uses the same login system via API Key.

### Expected Result

The fork should work exactly like the upstream - VS Code + Copilot. Users must have the EXACT same experience as having VS Code downloaded from the Microsoft website with Copilot installed. ALL upstream VS Code features must work EXACTLY the same in this fork.

No requests/data should be sent to any backend other than the permitted and authorized proprietary LLM provider.

## Project Structure

This is a VS Code fork with a custom chat extension (`extensions/stackcode-chat/`) that replaces GitHub Copilot with Stackspot AI. Two separate build systems exist:

- **VS Code Core** — Gulp-based, TypeScript compiled to `out/`
- **stackcode-chat Extension** — esbuild-based, bundled to `extensions/stackcode-chat/dist/extension.js`

## Build Commands

### VS Code Core (from repo root)
```bash
npm run compile              # Gulp compile (~3 min)
npm run watch                # Watch mode (client + extensions)
npm run build:macos:arm      # Full macOS ARM64 production build
```

### stackcode-chat Extension (from `extensions/stackcode-chat/`)
```bash
node .esbuild.ts --dev                # Dev build (~2s) — MUST run after every source change
node .esbuild.ts --sourcemaps         # Production build with source maps
npm run typecheck                     # Type-check all tsconfig projects
```

The Electron app loads `dist/extension.js`, NOT `out/` files. Always rebuild esbuild after changing extension source.

### Running the App
```bash
pkill -9 -f "StackCode"; pkill -9 -f "Electron"   # Kill existing instances first
./scripts/code.sh                                   # Launch dev mode
```

## Test Commands

### stackcode-chat Extension (from `extensions/stackcode-chat/`)
```bash
npm run test:unit                           # Vitest — all *.spec.ts files
npx vitest --run path/to/file.spec.ts       # Single Vitest unit test
npm run test:extension                      # VS Code extension host tests (*.test.ts)
npm run test:prompt                         # Mocha prompt tests
npm run test                                # All tests
```

### VS Code Core (from repo root)
```bash
npm run test-node                           # Mocha unit tests
npm run test-extension                      # Extension integration tests
```

### Test File Conventions
- `*.spec.ts` / `*.spec.tsx` — Vitest unit tests (no VS Code runtime)
- `*.test.ts` / `*.test.tsx` — Mocha tests inside VS Code extension host
- `*.sanity-test.ts` — Sanity smoke tests

To focus a single extension-host test, use `.only` (but ESLint will flag `no-test-only`).

## Lint & Formatting

### stackcode-chat Extension
```bash
npm run lint                # ESLint with --max-warnings=0 (zero tolerance)
npm run tsfmt               # TypeScript formatter (tabs, 4-width indent)
```

### VS Code Core
```bash
npm run eslint              # Custom ESLint runner
npm run hygiene             # Full hygiene check
```

### Key Lint Rules
- **Indent**: Tabs (4-space width); spaces for YAML/JSON (2-space)
- **Semicolons**: Required (`semi: error`)
- **Curly braces**: Required for all blocks (`curly: error`)
- **Equality**: Strict equality required (`eqeqeq: error`)
- **Layer enforcement**: `common/` cannot import from `vscode/`, `node/`, or `worker/`
- **Copyright header**: Microsoft license block required on all files
- **No `any`**: `@typescript-eslint/no-explicit-any` is `warn` with `fixToUnknown: true`

## TypeScript Configuration

| Setting | VS Code Core | stackcode-chat |
|---------|-------------|----------------|
| target | ES2024 | ES2022 |
| module | nodenext | commonjs |
| strict | true | true |
| JSX | N/A | react (custom factory: `vscpp`) |

## Code Style Guidelines

### Imports
1. License header (lines 1-4)
2. `import type` for type-only imports (never mix with runtime imports)
3. External packages (`'vscode'`, `'@vscode/prompt-tsx'`)
4. Internal relative imports (`../../../platform/...`, `../../tools/...`)

No default imports. No barrel re-exports. Specific named imports from individual files.

### Naming Conventions
| Element | Convention | Example |
|---------|-----------|---------|
| Interfaces | `I` prefix + PascalCase | `ILogService`, `IConfigurationService` |
| Classes | PascalCase (sometimes `Impl` suffix) | `StackspotChatEndpoint`, `LogServiceImpl` |
| Enums | PascalCase | `LogLevel`, `ToolName` |
| Constants | UPPER_SNAKE_CASE | `MAX_TOOL_RESULT_CHARS`, `SECRET_KEY_REALM` |
| Config objects | PascalCase | `BASE_PLAN_AGENT_CONFIG`, `DEFAULT_READ_TOOLS` |
| Private members | `_` prefix | `_logService`, `_handleParserEvent()` |
| Unused params | `_` prefix | `_token`, `_context` |
| Files | camelCase | `planAgentProvider.ts`, `toolNames.ts` |

### Dependency Injection
The project uses a VS Code-derived DI pattern with decorator-based injection:
```typescript
// Service identifier (same name as interface)
export const ILogService = createServiceIdentifier<ILogService>('ILogService');

// Constructor injection via decorators
constructor(
    @IConfigurationService private readonly configService: IConfigurationService,
    @ILogService private readonly logService: ILogService,
) { super(); }

// Service brand marker (required on implementations)
declare readonly _serviceBrand: undefined;

// Registration
builder.define(ILogService, new SyncDescriptor(LogServiceImpl));
```

### Disposable Pattern
Classes holding subscriptions extend `Disposable` and use `this._register()`:
```typescript
export class MyService extends Disposable {
    private readonly _onEvent = this._register(new vscode.EventEmitter<void>());
    constructor() {
        super();
        this._register(someService.onDidChange(() => { ... }));
    }
}
```

### Error Handling
- Wrap critical operations in try/catch with `ILogService` logging
- Prefix log messages with `[stackcode]` for Stackspot code or `[ClassName]` for general code
- Use `e instanceof Error ? e : new Error(String(e))` when passing to `logService.error()`
- Empty catch blocks acceptable only for non-critical cleanup (e.g., mkdir-if-not-exists)
- Distinguish `AbortError`/cancellation from real errors in async streams

### Logging
```typescript
this._logService.info('[stackcode] Descriptive message with context');
this._logService.error(err instanceof Error ? err : new Error(String(err)), '[stackcode] Context');
this._logService.trace(`[ClassName] Debug detail: ${value}`);  // trace for verbose
```

`ILogService.error()` signature: `error(error: string | Error, message?: string): void`

### Type Patterns
- `readonly` on all constructor-injected services and immutable properties
- `declare` for DI service brand markers (no runtime emission)
- `??` and `?.` for null-safe access (strict mode enabled)
- `export const enum` for internal perf-optimized enums; `export enum` for public APIs
- Explicit type annotations on public function signatures; inference for locals

## Architecture Notes

### Tool Naming (Three Layers)
1. **ToolName** — LLM-facing: `ask_questions`, `memory`, `read_file`
2. **ContributedToolName** — VS Code API: `copilot_askQuestions`, `copilot_memory`
3. **Tool set references** — Agent configs: `vscode/askQuestions`, `vscode/memory` (tool set name from `package.json` `languageModelToolSets`)

The `vscode` in `vscode/askQuestions` is the tool SET name, not branding. Do NOT rename it.

### Extension Bundle
The file `dist/extension.js` (~23MB) is what Electron loads. Source files in `src/` are NOT loaded directly. After any change to extension TypeScript, run `node .esbuild.ts --dev` from `extensions/stackcode-chat/`.
