# MiniMax Speech / Image / Video Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Speech (TTS), Image, and Video generation models to the MiniMax AI SDK provider, and upgrade the AI SDK dependencies to latest stable.

**Architecture:** Implement three standard AI SDK models — `ImageModelV3`, `SpeechModelV3`, `Experimental_VideoModelV3` — each in its own file with a sibling options file, mounted on BOTH existing provider instances (`minimaxOpenAI`, `minimaxAnthropic`). Shared concerns (business-error guard, `/v1` base derivation, hex decode, resolution map) live in `minimax-shared.ts`. Video uses internal polling (create → poll query → retrieve file URL), mirroring `@ai-sdk/fal`.

**Tech Stack:** TypeScript, `@ai-sdk/provider@^3.0.10`, `@ai-sdk/provider-utils@^4.0.27`, `@ai-sdk/anthropic@^3.0.81`, zod v4 (`zod/v4`), vitest (node + edge-runtime), tsup.

**Reference (the spec):** `docs/superpowers/specs/2026-06-02-multimodal-speech-image-video-design.md`

> **Progress:** Task 0 (test-config fix) and Task 1 (dep upgrade + LanguageModelV3 breaking-change migration) are DONE and committed (`64f4857`), verified green: `pnpm type-check` exit 0, `pnpm test` 17 pass (node + edge). Remaining: Tasks 2-13 (the new model files, provider wiring, exports, README).

---

## Conventions used throughout this plan

- **Provider id strings:** language models use `minimax.chat` / `minimax.messages`. New models use `minimax.image`, `minimax.speech`, `minimax.video`.
- **Env var:** `MINIMAX_API_KEY` (existing).
- **Test runner:** node config `vitest.node.config.mjs`, edge config `vitest.edge.config.mjs`. Run a single file with:
  `npx vitest --config vitest.node.config.mjs --run src/<file>.test.ts`
- **`config.url` shape:** new models take a `url: ({ path }: { path: string }) => string` builder plus `headers: () => Record<string,string|undefined>`, `fetch?`, and `_internal?: { currentDate?: () => Date }` — exactly like the existing `MinimaxChatLanguageModel` config.
- **Commit style:** conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). The repo enforces commitlint + a husky pre-commit that runs `pnpm lint`.

---

## Task 0: Fix the broken test scripts (prerequisite)

The `package.json` test scripts point at `vitest.node.config.js` / `vitest.edge.config.js`, but the actual files are `.mjs`. `pnpm test` currently fails at startup with `Could not resolve .../vitest.node.config.js`. The verification gate in every later task depends on `pnpm test` working, so fix this first.

**Files:**
- Modify: `package.json` (the `test:edge` and `test:node` scripts)

- [ ] **Step 1: Confirm the bug**

Run: `pnpm test:node`
Expected: FAIL — `Error: Build failed ... Could not resolve ".../vitest.node.config.js"`

- [ ] **Step 2: Fix the two script paths**

In `package.json`, change the `.js` extensions to `.mjs`:

```json
    "test:edge": "vitest --config vitest.edge.config.mjs --run",
    "test:node": "vitest --config vitest.node.config.mjs --run",
```

- [ ] **Step 3: Verify the full suite runs and passes**

Run: `pnpm test`
Expected: PASS — both `vitest.node.config.mjs` and `vitest.edge.config.mjs` run; `src/minimax-anthropic-provider.test.ts` (8) and `src/minimax-openai-provider.test.ts` (9) pass = 17 tests, twice (node + edge).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "fix: correct vitest config paths in test scripts (.js -> .mjs)"
```

---

## Task 1: Upgrade AI SDK dependencies to latest stable

Bump the three `@ai-sdk/*` deps from superseded beta tags to latest stable. Verified safe: same-major in-place upgrades, the `@ai-sdk/anthropic/internal` subpath export and `AnthropicMessagesLanguageModel` constructor are unchanged, transitive deps collapse to a single copy, all helpers used remain exported, zod v4 stays compatible.

**Files:**
- Modify: `package.json` (the `dependencies` block)
- Regenerate: `pnpm-lock.yaml` (via `pnpm install`)

- [ ] **Step 1: Edit the dependency versions**

In `package.json` `dependencies`, set:

```json
  "dependencies": {
    "@ai-sdk/anthropic": "^3.0.81",
    "@ai-sdk/provider": "^3.0.10",
    "@ai-sdk/provider-utils": "^4.0.27"
  },
```

- [ ] **Step 2: Install and regenerate the lockfile**

Run: `pnpm install`
Expected: resolves without peer-dependency errors; updates `pnpm-lock.yaml`.

- [ ] **Step 3: Observe the breaking-change compile errors**

Run: `pnpm type-check`
Expected: FAIL. Stable `@ai-sdk/provider@3.0.10` reshaped three `LanguageModelV3` types vs the old beta, so the EXISTING language model + message converter no longer compile. You will see errors like:
- `src/minimax-openai-language-model.ts(...): Type 'number | undefined' is not assignable to type '{ total: ...; text: ...; reasoning: ... }'` (usage shape)
- `src/minimax-openai-language-model.ts(...): Type 'string' is not assignable to type 'LanguageModelV3FinishReason'` (finish reason shape)
- `src/convert-to-minimax-chat-messages.ts(...): Property 'output' does not exist on type '... | LanguageModelV3ToolApprovalResponsePart'` (tool message union)

Steps 4-6 fix each. (These are migrations of EXISTING code forced by the upgrade — not the new modalities.)

- [ ] **Step 4: Migrate `LanguageModelV3Usage` (flat → nested) in the language model**

In `src/minimax-openai-language-model.ts`, there are two `usage:` return blocks (one in `doGenerate`, one in `doStream`'s `flush`). The new shape requires nested `inputTokens`/`outputTokens` objects with all keys present.

In `doGenerate` (the block currently returning `inputTokens: responseBody.usage?.prompt_tokens ?? undefined, ...`), replace with:

```ts
      usage: {
        inputTokens: {
          total: responseBody.usage?.prompt_tokens ?? undefined,
          noCache: undefined,
          cacheRead:
            responseBody.usage?.prompt_tokens_details?.cached_tokens ??
            undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: responseBody.usage?.completion_tokens ?? undefined,
          text: undefined,
          reasoning:
            responseBody.usage?.completion_tokens_details?.reasoning_tokens ??
            undefined,
        },
      },
```

In `doStream`'s `flush` (the block currently returning `inputTokens: usage.promptTokens ?? undefined, ...`), replace with:

```ts
              usage: {
                inputTokens: {
                  total: usage.promptTokens ?? undefined,
                  noCache: undefined,
                  cacheRead: usage.promptTokensDetails.cachedTokens ?? undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: usage.completionTokens ?? undefined,
                  text: undefined,
                  reasoning:
                    usage.completionTokensDetails.reasoningTokens ?? undefined,
                },
              },
```

(The `acceptedPredictionTokens` / `rejectedPredictionTokens` provider-metadata handling around these blocks is unchanged.)

- [ ] **Step 5: Migrate `LanguageModelV3FinishReason` (string union → `{ unified, raw }`)**

In `src/minimax-openai-language-model.ts`, replace the `mapOpenAICompatibleFinishReason` function with a version that returns the object shape (note: `'unknown'` was removed from the union → use `'other'`):

```ts
function mapOpenAICompatibleFinishReason(
  finishReason: string | null | undefined,
): LanguageModelV3FinishReason {
  return {
    unified: mapOpenAICompatibleFinishReasonUnified(finishReason),
    raw: finishReason ?? undefined,
  };
}

function mapOpenAICompatibleFinishReasonUnified(
  finishReason: string | null | undefined,
): LanguageModelV3FinishReason['unified'] {
  switch (finishReason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    case 'function_call':
    case 'tool_calls':
      return 'tool-calls';
    default:
      return 'other';
  }
}
```

Then fix the three raw assignments in `doStream`. The initializer:

```ts
    let finishReason: LanguageModelV3FinishReason = {
      unified: 'other',
      raw: undefined,
    };
```

And the two `finishReason = 'error';` lines (in the `!chunk.success` and `'error' in value` branches) become:

```ts
              finishReason = { unified: 'error', raw: undefined };
```

(The `finishReason = mapOpenAICompatibleFinishReason(choice.finish_reason)` call site needs no change — the helper now returns the object.)

- [ ] **Step 6: Migrate the tool-message union in the converter**

In `src/convert-to-minimax-chat-messages.ts`, the `case 'tool':` loop now iterates `Array<ToolResultPart | ToolApprovalResponsePart>`. Skip approval-response parts at the top of the loop so the rest narrows to `ToolResultPart`:

```ts
      case 'tool': {
        for (const toolResponse of content) {
          // Tool approval responses are not sent to the chat API.
          if (toolResponse.type === 'tool-approval-response') {
            continue;
          }

          const output = toolResponse.output;

          let contentValue: string;
          switch (output.type) {
```

(The rest of the loop body — the `output.type` switch and the `messages.push({ role: 'tool', ... })` — is unchanged. This also resolves the "`contentValue` is used before being assigned" error because the switch is now exhaustive over `ToolResultPart` outputs.)

- [ ] **Step 7: Verify the existing code type-checks and all tests pass**

Run: `pnpm type-check && pnpm test`
Expected: type-check exit 0; all 17 existing tests pass in both node and edge. This proves the anthropic `/internal` import still works and the language model is correctly migrated to stable.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/minimax-openai-language-model.ts src/convert-to-minimax-chat-messages.ts
git commit -m "chore: upgrade @ai-sdk deps to latest stable and migrate LanguageModelV3 breaking changes"
```

---

## Task 2: Shared helpers (`minimax-shared.ts`)

Small, dependency-free utilities reused by all three models. Build them test-first so the edge-safe hex decoder is proven before any model relies on it.

**Files:**
- Create: `src/minimax-shared.ts`
- Test: `src/minimax-shared.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/minimax-shared.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  hexToUint8Array,
  deriveV1BaseURL,
  mapVideoResolution,
  checkMinimaxBaseResp,
} from './minimax-shared';
import { APICallError } from '@ai-sdk/provider';

describe('hexToUint8Array', () => {
  it('decodes a hex string to bytes', () => {
    const bytes = hexToUint8Array('48656c6c6f');
    expect(Array.from(bytes)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('handles an uppercase hex string', () => {
    const bytes = hexToUint8Array('FF00A1');
    expect(Array.from(bytes)).toEqual([0xff, 0x00, 0xa1]);
  });

  it('returns empty for empty input', () => {
    expect(hexToUint8Array('').length).toBe(0);
  });
});

describe('deriveV1BaseURL', () => {
  it('strips a trailing /anthropic/v1 down to /v1', () => {
    expect(deriveV1BaseURL('https://api.minimax.io/anthropic/v1')).toBe(
      'https://api.minimax.io/v1',
    );
  });

  it('leaves a plain /v1 base unchanged', () => {
    expect(deriveV1BaseURL('https://api.minimax.io/v1')).toBe(
      'https://api.minimax.io/v1',
    );
  });
});

describe('mapVideoResolution', () => {
  it('maps 1080p sizes to "1080P"', () => {
    expect(mapVideoResolution('1920x1080')).toBe('1080P');
    expect(mapVideoResolution('1080x1920')).toBe('1080P');
  });

  it('maps 720p sizes to "720P"', () => {
    expect(mapVideoResolution('1280x720')).toBe('720P');
  });

  it('passes through an unknown size unchanged', () => {
    expect(mapVideoResolution('640x640')).toBe('640x640');
  });
});

describe('checkMinimaxBaseResp', () => {
  it('does not throw when status_code is 0', () => {
    expect(() =>
      checkMinimaxBaseResp(
        { status_code: 0, status_msg: 'success' },
        { url: 'https://x', requestBodyValues: {} },
      ),
    ).not.toThrow();
  });

  it('throws APICallError when status_code is non-zero', () => {
    expect(() =>
      checkMinimaxBaseResp(
        { status_code: 1004, status_msg: 'auth failed' },
        { url: 'https://x', requestBodyValues: {} },
      ),
    ).toThrow(APICallError);
  });

  it('does not throw when base_resp is missing', () => {
    expect(() =>
      checkMinimaxBaseResp(undefined, { url: 'https://x', requestBodyValues: {} }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-shared.test.ts`
Expected: FAIL — cannot resolve `./minimax-shared`.

- [ ] **Step 3: Implement the helpers**

Create `src/minimax-shared.ts`:

```ts
import { APICallError } from '@ai-sdk/provider';

/**
 * MiniMax base_resp envelope. status_code === 0 means success; any other value is a
 * business-layer error returned with HTTP 200.
 */
export interface MinimaxBaseResp {
  status_code?: number | null;
  status_msg?: string | null;
}

/**
 * Decodes a hex-encoded string into bytes. Edge-runtime safe (no Node Buffer):
 * the speech API returns audio as hex, and tests run under edge-runtime too.
 */
export function hexToUint8Array(hex: string): Uint8Array {
  const length = hex.length >> 1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Speech/image/video endpoints all live under `…/v1`. The anthropic-compatible
 * provider uses `…/anthropic/v1` for chat; strip the `/anthropic` segment so the
 * non-LLM models hit the right host.
 */
export function deriveV1BaseURL(baseURL: string): string {
  return baseURL.replace(/\/anthropic(\/v1)?$/, '$1');
}

/**
 * MiniMax video resolution is a label ("720P"/"768P"/"1080P"), not WxH. Map a
 * `${w}x${h}` size to the closest label; pass through unknown values unchanged.
 */
const RESOLUTION_MAP: Record<string, string> = {
  '1920x1080': '1080P',
  '1080x1920': '1080P',
  '1280x720': '720P',
  '720x1280': '720P',
  '1366x768': '768P',
  '768x1366': '768P',
};

export function mapVideoResolution(size: string): string {
  return RESOLUTION_MAP[size] ?? size;
}

/**
 * Throws an APICallError if the MiniMax base_resp reports a non-zero status_code.
 * MiniMax returns business errors with HTTP 200, so the standard failed-response
 * handler never sees them.
 */
export function checkMinimaxBaseResp(
  baseResp: MinimaxBaseResp | undefined | null,
  context: { url: string; requestBodyValues: unknown; responseBody?: string },
): void {
  if (baseResp == null) return;
  if (baseResp.status_code != null && baseResp.status_code !== 0) {
    throw new APICallError({
      message: baseResp.status_msg ?? `MiniMax error ${baseResp.status_code}`,
      url: context.url,
      requestBodyValues: context.requestBodyValues,
      responseBody: context.responseBody,
      data: baseResp,
      isRetryable: false,
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-shared.test.ts`
Expected: PASS — all 12 assertions green.

- [ ] **Step 5: Also run under edge-runtime (proves hex decode is edge-safe)**

Run: `npx vitest --config vitest.edge.config.mjs --run src/minimax-shared.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/minimax-shared.ts src/minimax-shared.test.ts
git commit -m "feat: add shared helpers for minimax multimodal models"
```

---

## Task 3: Image options (`minimax-image-options.ts`)

Model id type + provider-options zod schema for image generation.

**Files:**
- Create: `src/minimax-image-options.ts`

- [ ] **Step 1: Implement (no test — pure types/schema, covered by Task 4)**

Create `src/minimax-image-options.ts`:

```ts
import { z } from 'zod/v4';

// https://platform.minimaxi.com/docs/api-reference/image-generation-t2i
export type MinimaxImageModelId = 'image-01' | 'image-01-live' | (string & {});

/** A single subject reference entry for image-to-image (subject_reference). */
export const minimaxSubjectReference = z.object({
  type: z.literal('character'),
  image_file: z.string(),
});

export const minimaxImageProviderOptions = z.object({
  /** Enable automatic prompt enhancement. MiniMax default: false. */
  promptOptimizer: z.boolean().optional(),
  /** Add an AIGC watermark to generated images. */
  aigcWatermark: z.boolean().optional(),
  /** Style controls (image-01-live only). */
  style: z
    .object({
      style_type: z.string().optional(),
      style_weight: z.number().optional(),
    })
    .optional(),
  /** Subject reference for image-to-image. Array of {type:'character', image_file}. */
  subjectReference: z.array(minimaxSubjectReference).optional(),
});

export type MinimaxImageProviderOptions = z.infer<
  typeof minimaxImageProviderOptions
>;
```

- [ ] **Step 2: Type-check**

Run: `pnpm type-check`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/minimax-image-options.ts
git commit -m "feat: add minimax image model options"
```

---

## Task 4: Image model (`minimax-image-model.ts`)

`ImageModelV3` implementation. Posts to `/image_generation`, forces `response_format: 'base64'`, returns base64 strings.

**Files:**
- Create: `src/minimax-image-model.ts`
- Test: `src/minimax-image-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/minimax-image-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MinimaxImageModel } from './minimax-image-model';

const TEST_DATE = new Date('2026-06-02T00:00:00Z');

function makeModel(fetchImpl: typeof fetch) {
  return new MinimaxImageModel('image-01', {
    provider: 'minimax.image',
    url: ({ path }) => `https://api.minimax.io/v1${path}`,
    headers: () => ({ Authorization: 'Bearer test-key' }),
    fetch: fetchImpl,
    _internal: { currentDate: () => TEST_DATE },
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MinimaxImageModel', () => {
  it('has v3 spec, provider, and maxImagesPerCall', () => {
    const model = makeModel(async () => jsonResponse({}));
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('minimax.image');
    expect(model.modelId).toBe('image-01');
    expect(model.maxImagesPerCall).toBe(9);
  });

  it('sends n, size->width/height, forces base64, and returns images', async () => {
    let captured: any;
    const model = makeModel(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({
        data: { image_base64: ['AAAA', 'BBBB'] },
        metadata: { success_count: 2, failed_count: 0 },
        base_resp: { status_code: 0, status_msg: 'success' },
      });
    });

    const result = await model.doGenerate({
      prompt: 'a cat',
      n: 2,
      size: '1024x768',
      aspectRatio: undefined,
      seed: 7,
      providerOptions: {},
    });

    expect(captured.model).toBe('image-01');
    expect(captured.prompt).toBe('a cat');
    expect(captured.n).toBe(2);
    expect(captured.width).toBe(1024);
    expect(captured.height).toBe(768);
    expect(captured.response_format).toBe('base64');
    expect(captured.seed).toBe(7);
    expect(result.images).toEqual(['AAAA', 'BBBB']);
    expect(result.warnings).toEqual([]);
    expect(result.response.modelId).toBe('image-01');
    expect(result.response.timestamp).toEqual(TEST_DATE);
  });

  it('maps aspectRatio when size is absent', async () => {
    let captured: any;
    const model = makeModel(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({
        data: { image_base64: ['AAAA'] },
        base_resp: { status_code: 0 },
      });
    });

    await model.doGenerate({
      prompt: 'x',
      n: 1,
      size: undefined,
      aspectRatio: '16:9',
      seed: undefined,
      providerOptions: {},
    });

    expect(captured.aspect_ratio).toBe('16:9');
    expect(captured.width).toBeUndefined();
  });

  it('warns and prefers size when both size and aspectRatio are given', async () => {
    let captured: any;
    const model = makeModel(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({
        data: { image_base64: ['AAAA'] },
        base_resp: { status_code: 0 },
      });
    });

    const result = await model.doGenerate({
      prompt: 'x',
      n: 1,
      size: '512x512',
      aspectRatio: '16:9',
      seed: undefined,
      providerOptions: {},
    });

    expect(captured.width).toBe(512);
    expect(captured.aspect_ratio).toBeUndefined();
    expect(result.warnings).toContainEqual({
      type: 'unsupported',
      feature: 'aspectRatio',
      details: 'size takes precedence; aspectRatio ignored.',
    });
  });

  it('passes provider options (promptOptimizer, subjectReference)', async () => {
    let captured: any;
    const model = makeModel(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({
        data: { image_base64: ['AAAA'] },
        base_resp: { status_code: 0 },
      });
    });

    await model.doGenerate({
      prompt: 'x',
      n: 1,
      size: undefined,
      aspectRatio: undefined,
      seed: undefined,
      providerOptions: {
        minimax: {
          promptOptimizer: true,
          subjectReference: [{ type: 'character', image_file: 'https://img/1.jpg' }],
        },
      },
    });

    expect(captured.prompt_optimizer).toBe(true);
    expect(captured.subject_reference).toEqual([
      { type: 'character', image_file: 'https://img/1.jpg' },
    ]);
  });

  it('throws on a non-zero base_resp', async () => {
    const model = makeModel(async () =>
      jsonResponse({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }),
    );

    await expect(
      model.doGenerate({
        prompt: 'x',
        n: 1,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        providerOptions: {},
      }),
    ).rejects.toThrow(/auth failed/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-image-model.test.ts`
Expected: FAIL — cannot resolve `./minimax-image-model`.

- [ ] **Step 3: Implement the model**

Create `src/minimax-image-model.ts`:

```ts
import {
  ImageModelV3,
  SharedV3Warning,
} from '@ai-sdk/provider';
import {
  combineHeaders,
  createJsonResponseHandler,
  createJsonErrorResponseHandler,
  FetchFunction,
  parseProviderOptions,
  postJsonToApi,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import {
  MinimaxImageModelId,
  minimaxImageProviderOptions,
} from './minimax-image-options';
import { defaultMinimaxErrorStructure } from './minimax-chat-options';
import { checkMinimaxBaseResp } from './minimax-shared';

export interface MinimaxImageModelConfig {
  provider: string;
  url: (options: { path: string; modelId: string }) => string;
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
  _internal?: { currentDate?: () => Date };
}

const minimaxImageResponseSchema = z.object({
  data: z
    .object({
      image_base64: z.array(z.string()).nullish(),
      image_urls: z.array(z.string()).nullish(),
    })
    .nullish(),
  metadata: z
    .object({
      success_count: z.number().nullish(),
      failed_count: z.number().nullish(),
    })
    .nullish(),
  base_resp: z
    .object({
      status_code: z.number().nullish(),
      status_msg: z.string().nullish(),
    })
    .nullish(),
});

export class MinimaxImageModel implements ImageModelV3 {
  readonly specificationVersion = 'v3';
  readonly maxImagesPerCall = 9;

  constructor(
    readonly modelId: MinimaxImageModelId,
    private readonly config: MinimaxImageModelConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  async doGenerate({
    prompt,
    n,
    size,
    aspectRatio,
    seed,
    providerOptions,
    headers,
    abortSignal,
  }: Parameters<ImageModelV3['doGenerate']>[0]): Promise<
    Awaited<ReturnType<ImageModelV3['doGenerate']>>
  > {
    const warnings: Array<SharedV3Warning> = [];

    const options =
      (await parseProviderOptions({
        provider: 'minimax',
        providerOptions,
        schema: minimaxImageProviderOptions,
      })) ?? {};

    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt,
      n,
      response_format: 'base64',
      seed,
      prompt_optimizer: options.promptOptimizer,
      aigc_watermark: options.aigcWatermark,
      style: options.style,
      subject_reference: options.subjectReference,
    };

    // size and aspect_ratio are mutually exclusive server-side; size wins.
    if (size != null) {
      const [width, height] = size.split('x').map(s => parseInt(s, 10));
      body.width = width;
      body.height = height;
      if (aspectRatio != null) {
        warnings.push({
          type: 'unsupported',
          feature: 'aspectRatio',
          details: 'size takes precedence; aspectRatio ignored.',
        });
      }
    } else if (aspectRatio != null) {
      body.aspect_ratio = aspectRatio;
    }

    const url = this.config.url({ path: '/image_generation', modelId: this.modelId });

    const { value: response, responseHeaders } = await postJsonToApi({
      url,
      headers: combineHeaders(this.config.headers(), headers),
      body,
      failedResponseHandler: createJsonErrorResponseHandler(
        defaultMinimaxErrorStructure,
      ),
      successfulResponseHandler: createJsonResponseHandler(
        minimaxImageResponseSchema,
      ),
      abortSignal,
      fetch: this.config.fetch,
    });

    checkMinimaxBaseResp(response.base_resp, { url, requestBodyValues: body });

    const images = response.data?.image_base64 ?? [];
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();

    return {
      images,
      warnings,
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
      },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-image-model.test.ts`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Type-check**

Run: `pnpm type-check`
Expected: exit 0. (`SharedV3Warning` is the correct warning type — `ImageModelV3CallWarning` is NOT exported by `@ai-sdk/provider@3.0.10`. The warning object shape is `{ type: 'unsupported', feature, details? }`.)

- [ ] **Step 6: Commit**

```bash
git add src/minimax-image-model.ts src/minimax-image-model.test.ts
git commit -m "feat: add minimax image model (ImageModelV3)"
```

---

## Task 5: Speech options (`minimax-speech-options.ts`)

**Files:**
- Create: `src/minimax-speech-options.ts`

- [ ] **Step 1: Implement**

Create `src/minimax-speech-options.ts`:

```ts
import { z } from 'zod/v4';

// https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
export type MinimaxSpeechModelId =
  | 'speech-2.8-hd'
  | 'speech-2.8-turbo'
  | 'speech-2.6-hd'
  | 'speech-2.6-turbo'
  | 'speech-02-hd'
  | 'speech-02-turbo'
  | (string & {});

/** API requires a voice_id; used when the caller does not pass `voice`. */
export const DEFAULT_MINIMAX_VOICE_ID = 'male-qn-qingse';

export const minimaxSpeechProviderOptions = z.object({
  /** Volume, range (0, 10]. */
  vol: z.number().optional(),
  /** Pitch, range [-12, 12]. */
  pitch: z.number().optional(),
  /** Emotion, e.g. "happy", "sad", "neutral". */
  emotion: z.string().optional(),
  /** Output sample rate in Hz, e.g. 32000. */
  sampleRate: z.number().optional(),
  /** Output bitrate, e.g. 128000. */
  bitrate: z.number().optional(),
  /** Channels: 1 (mono) or 2 (stereo). */
  channel: z.number().optional(),
  /** Custom pronunciation rules. */
  pronunciationDict: z.record(z.string(), z.unknown()).optional(),
});

export type MinimaxSpeechProviderOptions = z.infer<
  typeof minimaxSpeechProviderOptions
>;
```

- [ ] **Step 2: Type-check**

Run: `pnpm type-check`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/minimax-speech-options.ts
git commit -m "feat: add minimax speech model options"
```

---

## Task 6: Speech model (`minimax-speech-model.ts`)

`SpeechModelV3` implementation. Posts to `/t2a_v2`, forces `output_format: 'hex'`, decodes the hex audio to `Uint8Array`.

**Files:**
- Create: `src/minimax-speech-model.ts`
- Test: `src/minimax-speech-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/minimax-speech-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MinimaxSpeechModel } from './minimax-speech-model';

const TEST_DATE = new Date('2026-06-02T00:00:00Z');

function makeModel(fetchImpl: typeof fetch) {
  return new MinimaxSpeechModel('speech-2.6-hd', {
    provider: 'minimax.speech',
    url: ({ path }) => `https://api.minimax.io/v1${path}`,
    headers: () => ({ Authorization: 'Bearer test-key' }),
    fetch: fetchImpl,
    _internal: { currentDate: () => TEST_DATE },
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MinimaxSpeechModel', () => {
  it('has v3 spec and provider', () => {
    const model = makeModel(async () => jsonResponse({}));
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('minimax.speech');
    expect(model.modelId).toBe('speech-2.6-hd');
  });

  it('maps text/voice/speed/format, forces hex, decodes audio to bytes', async () => {
    let captured: any;
    const model = makeModel(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({
        data: { audio: '48656c6c6f', status: 2 },
        extra_info: { audio_length: 1000, audio_sample_rate: 32000 },
        base_resp: { status_code: 0, status_msg: 'success' },
      });
    });

    const result = await model.doGenerate({
      text: 'Hello',
      voice: 'female-1',
      outputFormat: 'wav',
      speed: 1.2,
      providerOptions: {},
    });

    expect(captured.model).toBe('speech-2.6-hd');
    expect(captured.text).toBe('Hello');
    expect(captured.voice_setting.voice_id).toBe('female-1');
    expect(captured.voice_setting.speed).toBe(1.2);
    expect(captured.audio_setting.format).toBe('wav');
    expect(captured.output_format).toBe('hex');
    expect(captured.stream).toBe(false);
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.audio as Uint8Array)).toEqual([
      0x48, 0x65, 0x6c, 0x6c, 0x6f,
    ]);
    expect(result.response.modelId).toBe('speech-2.6-hd');
    expect(result.response.timestamp).toEqual(TEST_DATE);
  });

  it('uses the default voice_id when voice is omitted', async () => {
    let captured: any;
    const model = makeModel(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({
        data: { audio: '00' },
        base_resp: { status_code: 0 },
      });
    });

    await model.doGenerate({ text: 'hi', providerOptions: {} });
    expect(captured.voice_setting.voice_id).toBe('male-qn-qingse');
  });

  it('maps provider options into voice_setting and audio_setting', async () => {
    let captured: any;
    const model = makeModel(async (_url, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({
        data: { audio: '00' },
        base_resp: { status_code: 0 },
      });
    });

    await model.doGenerate({
      text: 'hi',
      providerOptions: {
        minimax: { emotion: 'happy', vol: 5, sampleRate: 32000, channel: 2 },
      },
    });

    expect(captured.voice_setting.emotion).toBe('happy');
    expect(captured.voice_setting.vol).toBe(5);
    expect(captured.audio_setting.sample_rate).toBe(32000);
    expect(captured.audio_setting.channel).toBe(2);
  });

  it('throws on a non-zero base_resp', async () => {
    const model = makeModel(async () =>
      jsonResponse({ base_resp: { status_code: 2013, status_msg: 'invalid params' } }),
    );

    await expect(
      model.doGenerate({ text: 'hi', providerOptions: {} }),
    ).rejects.toThrow(/invalid params/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-speech-model.test.ts`
Expected: FAIL — cannot resolve `./minimax-speech-model`.

- [ ] **Step 3: Implement the model**

Create `src/minimax-speech-model.ts`:

```ts
import {
  SpeechModelV3,
  SharedV3Warning,
} from '@ai-sdk/provider';
import {
  combineHeaders,
  createJsonResponseHandler,
  createJsonErrorResponseHandler,
  FetchFunction,
  parseProviderOptions,
  postJsonToApi,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import {
  MinimaxSpeechModelId,
  minimaxSpeechProviderOptions,
  DEFAULT_MINIMAX_VOICE_ID,
} from './minimax-speech-options';
import { defaultMinimaxErrorStructure } from './minimax-chat-options';
import { checkMinimaxBaseResp, hexToUint8Array } from './minimax-shared';

export interface MinimaxSpeechModelConfig {
  provider: string;
  url: (options: { path: string; modelId: string }) => string;
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
  _internal?: { currentDate?: () => Date };
}

const minimaxSpeechResponseSchema = z.object({
  data: z
    .object({
      audio: z.string().nullish(),
      status: z.number().nullish(),
    })
    .nullish(),
  extra_info: z.record(z.string(), z.unknown()).nullish(),
  base_resp: z
    .object({
      status_code: z.number().nullish(),
      status_msg: z.string().nullish(),
    })
    .nullish(),
});

export class MinimaxSpeechModel implements SpeechModelV3 {
  readonly specificationVersion = 'v3';

  constructor(
    readonly modelId: MinimaxSpeechModelId,
    private readonly config: MinimaxSpeechModelConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  async doGenerate(
    options: Parameters<SpeechModelV3['doGenerate']>[0],
  ): Promise<Awaited<ReturnType<SpeechModelV3['doGenerate']>>> {
    const { text, voice, outputFormat, speed, language, providerOptions, headers, abortSignal } =
      options;
    const warnings: Array<SharedV3Warning> = [];

    const opts =
      (await parseProviderOptions({
        provider: 'minimax',
        providerOptions,
        schema: minimaxSpeechProviderOptions,
      })) ?? {};

    const voiceSetting: Record<string, unknown> = {
      voice_id: voice ?? DEFAULT_MINIMAX_VOICE_ID,
      speed,
      vol: opts.vol,
      pitch: opts.pitch,
      emotion: opts.emotion,
    };

    const audioSetting: Record<string, unknown> = {
      format: outputFormat,
      sample_rate: opts.sampleRate,
      bitrate: opts.bitrate,
      channel: opts.channel,
    };

    const body: Record<string, unknown> = {
      model: this.modelId,
      text,
      stream: false,
      output_format: 'hex',
      voice_setting: voiceSetting,
      audio_setting: audioSetting,
      language_boost: language,
      pronunciation_dict: opts.pronunciationDict,
    };

    const url = this.config.url({ path: '/t2a_v2', modelId: this.modelId });

    const { value: response, responseHeaders, rawValue } = await postJsonToApi({
      url,
      headers: combineHeaders(this.config.headers(), headers),
      body,
      failedResponseHandler: createJsonErrorResponseHandler(
        defaultMinimaxErrorStructure,
      ),
      successfulResponseHandler: createJsonResponseHandler(
        minimaxSpeechResponseSchema,
      ),
      abortSignal,
      fetch: this.config.fetch,
    });

    checkMinimaxBaseResp(response.base_resp, { url, requestBodyValues: body });

    const audio = hexToUint8Array(response.data?.audio ?? '');
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();

    return {
      audio,
      warnings,
      request: { body: JSON.stringify(body) },
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
        body: rawValue,
      },
      providerMetadata: {
        minimax: {
          ...(response.extra_info ?? {}),
        },
      },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-speech-model.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Run under edge-runtime (proves hex decode works in edge)**

Run: `npx vitest --config vitest.edge.config.mjs --run src/minimax-speech-model.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `pnpm type-check`
Expected: exit 0. (`SharedV3Warning` is the correct warning type — `SpeechModelV3CallWarning` is NOT exported. Also: `providerMetadata` values must be JSON — `extra_info` is parsed JSON so this is safe; if type-check complains, cast via `as Record<string, JSONValue>` imported from `@ai-sdk/provider`.)

- [ ] **Step 7: Commit**

```bash
git add src/minimax-speech-model.ts src/minimax-speech-model.test.ts
git commit -m "feat: add minimax speech model (SpeechModelV3)"
```

---

## Task 7: Video options (`minimax-video-options.ts`)

**Files:**
- Create: `src/minimax-video-options.ts`

- [ ] **Step 1: Implement**

Create `src/minimax-video-options.ts`:

```ts
import { z } from 'zod/v4';

// https://platform.minimaxi.com/docs/api-reference/video-generation-t2v
// Note: MiniMax-Hailuo-2.3-Fast is image-to-video ONLY (not valid for text-to-video).
export type MinimaxVideoModelId =
  | 'MiniMax-Hailuo-2.3'
  | 'MiniMax-Hailuo-2.3-Fast'
  | 'MiniMax-Hailuo-02'
  | (string & {});

export const DEFAULT_VIDEO_POLL_INTERVAL_MS = 5000;
export const DEFAULT_VIDEO_POLL_TIMEOUT_MS = 600000; // 10 minutes

export const minimaxVideoProviderOptions = z.object({
  /** Enable automatic prompt enhancement. MiniMax video default: true. */
  promptOptimizer: z.boolean().optional(),
  /** Faster pre-processing at some quality cost. */
  fastPretreatment: z.boolean().optional(),
  /** Add an AIGC watermark. */
  aigcWatermark: z.boolean().optional(),
  /** Async completion callback URL. */
  callbackUrl: z.string().optional(),
  /** Poll interval in ms while waiting for the video. Default 5000. */
  pollIntervalMs: z.number().positive().optional(),
  /** Poll timeout in ms before giving up. Default 600000. */
  pollTimeoutMs: z.number().positive().optional(),
});

export type MinimaxVideoProviderOptions = z.infer<
  typeof minimaxVideoProviderOptions
>;
```

- [ ] **Step 2: Type-check**

Run: `pnpm type-check`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/minimax-video-options.ts
git commit -m "feat: add minimax video model options"
```

---

## Task 8: Video model (`minimax-video-model.ts`)

`Experimental_VideoModelV3` with internal polling: create task → poll query until `Success` → retrieve file `download_url`.

**Files:**
- Create: `src/minimax-video-model.ts`
- Test: `src/minimax-video-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/minimax-video-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MinimaxVideoModel } from './minimax-video-model';

const TEST_DATE = new Date('2026-06-02T00:00:00Z');

function makeModel(fetchImpl: typeof fetch, overrides?: Record<string, unknown>) {
  return new MinimaxVideoModel('MiniMax-Hailuo-2.3', {
    provider: 'minimax.video',
    url: ({ path }) => `https://api.minimax.io/v1${path}`,
    headers: () => ({ Authorization: 'Bearer test-key' }),
    fetch: fetchImpl,
    _internal: { currentDate: () => TEST_DATE },
    ...overrides,
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Default provider options: tiny poll interval so tests run instantly.
const fastPoll = { minimax: { pollIntervalMs: 1, pollTimeoutMs: 5000 } };

describe('MinimaxVideoModel', () => {
  it('has v3 spec, provider, and maxVideosPerCall=1', () => {
    const model = makeModel(async () => jsonResponse({}));
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('minimax.video');
    expect(model.maxVideosPerCall).toBe(1);
  });

  it('creates a task, polls until Success, retrieves the download url', async () => {
    const calls: string[] = [];
    let queryCount = 0;
    const model = makeModel(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/video_generation')) {
        return jsonResponse({ task_id: 'task-1', base_resp: { status_code: 0 } });
      }
      if (u.includes('/query/video_generation')) {
        queryCount++;
        if (queryCount < 2) {
          return jsonResponse({ task_id: 'task-1', status: 'Processing', base_resp: { status_code: 0 } });
        }
        return jsonResponse({
          task_id: 'task-1',
          status: 'Success',
          file_id: 'file-9',
          video_width: 1280,
          video_height: 720,
          base_resp: { status_code: 0 },
        });
      }
      if (u.includes('/files/retrieve')) {
        return jsonResponse({
          file: { file_id: 'file-9', download_url: 'https://cdn/video.mp4' },
          base_resp: { status_code: 0 },
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const result = await model.doGenerate({
      prompt: 'a dog running',
      n: 1,
      aspectRatio: undefined,
      resolution: undefined,
      duration: 6,
      fps: undefined,
      seed: undefined,
      image: undefined,
      providerOptions: fastPoll,
    });

    expect(result.videos).toEqual([
      { type: 'url', url: 'https://cdn/video.mp4', mediaType: 'video/mp4' },
    ]);
    expect(result.providerMetadata?.minimax).toMatchObject({
      taskId: 'task-1',
      fileId: 'file-9',
      width: 1280,
      height: 720,
    });
    expect(result.response.modelId).toBe('MiniMax-Hailuo-2.3');
    // create + 2 query + retrieve
    expect(calls.filter(c => c.includes('/query/')).length).toBe(2);
  });

  it('maps resolution size to a MiniMax label and i2v image to first_frame_image', async () => {
    let createBody: any;
    const model = makeModel(async (url, init) => {
      const u = String(url);
      if (u.includes('/video_generation') && !u.includes('/query/')) {
        createBody = JSON.parse((init as RequestInit).body as string);
        return jsonResponse({ task_id: 't', base_resp: { status_code: 0 } });
      }
      if (u.includes('/query/video_generation')) {
        return jsonResponse({ task_id: 't', status: 'Success', file_id: 'f', base_resp: { status_code: 0 } });
      }
      return jsonResponse({ file: { download_url: 'https://cdn/v.mp4' }, base_resp: { status_code: 0 } });
    });

    await model.doGenerate({
      prompt: 'x',
      n: 1,
      aspectRatio: undefined,
      resolution: '1920x1080',
      duration: undefined,
      fps: undefined,
      seed: undefined,
      image: { type: 'url', url: 'https://img/first.jpg' } as any,
      providerOptions: fastPoll,
    });

    expect(createBody.resolution).toBe('1080P');
    expect(createBody.first_frame_image).toBe('https://img/first.jpg');
  });

  it('throws when the task status is Fail', async () => {
    const model = makeModel(async (url) => {
      const u = String(url);
      if (u.includes('/video_generation') && !u.includes('/query/')) {
        return jsonResponse({ task_id: 't', base_resp: { status_code: 0 } });
      }
      return jsonResponse({ task_id: 't', status: 'Fail', base_resp: { status_code: 0 } });
    });

    await expect(
      model.doGenerate({
        prompt: 'x',
        n: 1,
        aspectRatio: undefined,
        resolution: undefined,
        duration: undefined,
        fps: undefined,
        seed: undefined,
        image: undefined,
        providerOptions: fastPoll,
      }),
    ).rejects.toThrow(/failed/i);
  });

  it('times out when never reaching Success', async () => {
    const model = makeModel(async (url) => {
      const u = String(url);
      if (u.includes('/video_generation') && !u.includes('/query/')) {
        return jsonResponse({ task_id: 't', base_resp: { status_code: 0 } });
      }
      return jsonResponse({ task_id: 't', status: 'Processing', base_resp: { status_code: 0 } });
    });

    await expect(
      model.doGenerate({
        prompt: 'x',
        n: 1,
        aspectRatio: undefined,
        resolution: undefined,
        duration: undefined,
        fps: undefined,
        seed: undefined,
        image: undefined,
        providerOptions: { minimax: { pollIntervalMs: 1, pollTimeoutMs: 5 } },
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('warns on unsupported fps and n>1', async () => {
    const model = makeModel(async (url) => {
      const u = String(url);
      if (u.includes('/video_generation') && !u.includes('/query/')) {
        return jsonResponse({ task_id: 't', base_resp: { status_code: 0 } });
      }
      if (u.includes('/query/video_generation')) {
        return jsonResponse({ task_id: 't', status: 'Success', file_id: 'f', base_resp: { status_code: 0 } });
      }
      return jsonResponse({ file: { download_url: 'https://cdn/v.mp4' }, base_resp: { status_code: 0 } });
    });

    const result = await model.doGenerate({
      prompt: 'x',
      n: 2,
      aspectRatio: undefined,
      resolution: undefined,
      duration: undefined,
      fps: 30,
      seed: undefined,
      image: undefined,
      providerOptions: fastPoll,
    });

    expect(result.warnings.some(w => w.type === 'unsupported' && w.feature === 'fps')).toBe(true);
    expect(result.warnings.some(w => w.type === 'unsupported' && w.feature === 'n')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-video-model.test.ts`
Expected: FAIL — cannot resolve `./minimax-video-model`.

- [ ] **Step 3: Implement the model**

Create `src/minimax-video-model.ts`:

```ts
import {
  AISDKError,
  Experimental_VideoModelV3,
  SharedV3Warning,
} from '@ai-sdk/provider';
import {
  combineHeaders,
  convertImageModelFileToDataUri,
  createJsonResponseHandler,
  createJsonErrorResponseHandler,
  delay,
  FetchFunction,
  getFromApi,
  parseProviderOptions,
  postJsonToApi,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import {
  MinimaxVideoModelId,
  minimaxVideoProviderOptions,
  DEFAULT_VIDEO_POLL_INTERVAL_MS,
  DEFAULT_VIDEO_POLL_TIMEOUT_MS,
} from './minimax-video-options';
import { defaultMinimaxErrorStructure } from './minimax-chat-options';
import { checkMinimaxBaseResp, mapVideoResolution } from './minimax-shared';

export interface MinimaxVideoModelConfig {
  provider: string;
  url: (options: { path: string; modelId: string }) => string;
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
  _internal?: { currentDate?: () => Date };
}

const baseRespSchema = z
  .object({
    status_code: z.number().nullish(),
    status_msg: z.string().nullish(),
  })
  .nullish();

const createTaskResponseSchema = z.object({
  task_id: z.string().nullish(),
  base_resp: baseRespSchema,
});

const queryTaskResponseSchema = z.object({
  task_id: z.string().nullish(),
  status: z.string().nullish(),
  file_id: z.string().nullish(),
  video_width: z.number().nullish(),
  video_height: z.number().nullish(),
  base_resp: baseRespSchema,
});

const fileRetrieveResponseSchema = z.object({
  file: z
    .object({
      file_id: z.union([z.string(), z.number()]).nullish(),
      download_url: z.string().nullish(),
    })
    .nullish(),
  base_resp: baseRespSchema,
});

export class MinimaxVideoModel implements Experimental_VideoModelV3 {
  readonly specificationVersion = 'v3';
  readonly maxVideosPerCall = 1;

  constructor(
    readonly modelId: MinimaxVideoModelId,
    private readonly config: MinimaxVideoModelConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  async doGenerate(
    options: Parameters<Experimental_VideoModelV3['doGenerate']>[0],
  ): Promise<Awaited<ReturnType<Experimental_VideoModelV3['doGenerate']>>> {
    const { prompt, n, resolution, duration, fps, seed, image, providerOptions, headers, abortSignal } =
      options;
    const warnings: Array<SharedV3Warning> = [];

    if (fps != null) {
      warnings.push({ type: 'unsupported', feature: 'fps' });
    }
    if (n != null && n > 1) {
      warnings.push({
        type: 'unsupported',
        feature: 'n',
        details: 'MiniMax generates one video per call; only 1 will be produced.',
      });
    }

    const opts =
      (await parseProviderOptions({
        provider: 'minimax',
        providerOptions,
        schema: minimaxVideoProviderOptions,
      })) ?? {};

    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt,
      duration,
      seed,
      prompt_optimizer: opts.promptOptimizer,
      fast_pretreatment: opts.fastPretreatment,
      aigc_watermark: opts.aigcWatermark,
      callback_url: opts.callbackUrl,
    };

    if (resolution != null) {
      body.resolution = mapVideoResolution(resolution);
    }

    if (image != null) {
      body.first_frame_image =
        image.type === 'url' ? image.url : convertImageModelFileToDataUri(image);
    }

    const reqHeaders = combineHeaders(this.config.headers(), headers);
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();

    // 1) Create task
    const createUrl = this.config.url({ path: '/video_generation', modelId: this.modelId });
    const { value: createResponse } = await postJsonToApi({
      url: createUrl,
      headers: reqHeaders,
      body,
      failedResponseHandler: createJsonErrorResponseHandler(defaultMinimaxErrorStructure),
      successfulResponseHandler: createJsonResponseHandler(createTaskResponseSchema),
      abortSignal,
      fetch: this.config.fetch,
    });
    checkMinimaxBaseResp(createResponse.base_resp, { url: createUrl, requestBodyValues: body });

    const taskId = createResponse.task_id;
    if (!taskId) {
      throw new AISDKError({
        name: 'MINIMAX_VIDEO_GENERATION_ERROR',
        message: 'No task_id returned from /video_generation',
      });
    }

    // 2) Poll until Success / Fail / timeout
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS;
    const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_VIDEO_POLL_TIMEOUT_MS;
    const startTime = (this.config._internal?.currentDate?.() ?? new Date()).getTime();

    let fileId: string | undefined;
    let width: number | undefined;
    let height: number | undefined;

    while (true) {
      const queryUrl = this.config.url({
        path: `/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
        modelId: this.modelId,
      });
      const { value: status } = await getFromApi({
        url: queryUrl,
        headers: reqHeaders,
        failedResponseHandler: createJsonErrorResponseHandler(defaultMinimaxErrorStructure),
        successfulResponseHandler: createJsonResponseHandler(queryTaskResponseSchema),
        abortSignal,
        fetch: this.config.fetch,
      });
      checkMinimaxBaseResp(status.base_resp, { url: queryUrl, requestBodyValues: {} });

      if (status.status === 'Success') {
        fileId = status.file_id ?? undefined;
        width = status.video_width ?? undefined;
        height = status.video_height ?? undefined;
        break;
      }
      if (status.status === 'Fail') {
        throw new AISDKError({
          name: 'MINIMAX_VIDEO_GENERATION_FAILED',
          message: `Video generation failed for task ${taskId}`,
        });
      }
      if (Date.now() - startTime > pollTimeoutMs) {
        throw new AISDKError({
          name: 'MINIMAX_VIDEO_GENERATION_TIMEOUT',
          message: `Video generation timed out after ${pollTimeoutMs}ms (task ${taskId})`,
        });
      }
      await delay(pollIntervalMs, { abortSignal });
    }

    if (!fileId) {
      throw new AISDKError({
        name: 'MINIMAX_VIDEO_GENERATION_ERROR',
        message: `Task ${taskId} succeeded but returned no file_id`,
      });
    }

    // 3) Retrieve the file download URL
    const retrieveUrl = this.config.url({
      path: `/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
      modelId: this.modelId,
    });
    const { value: fileResponse, responseHeaders } = await getFromApi({
      url: retrieveUrl,
      headers: reqHeaders,
      failedResponseHandler: createJsonErrorResponseHandler(defaultMinimaxErrorStructure),
      successfulResponseHandler: createJsonResponseHandler(fileRetrieveResponseSchema),
      abortSignal,
      fetch: this.config.fetch,
    });
    checkMinimaxBaseResp(fileResponse.base_resp, { url: retrieveUrl, requestBodyValues: {} });

    const downloadUrl = fileResponse.file?.download_url;
    if (!downloadUrl) {
      throw new AISDKError({
        name: 'MINIMAX_VIDEO_GENERATION_ERROR',
        message: `No download_url for file ${fileId}`,
      });
    }

    return {
      videos: [{ type: 'url', url: downloadUrl, mediaType: 'video/mp4' }],
      warnings,
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
      },
      providerMetadata: {
        minimax: { taskId, fileId, width, height },
      },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-video-model.test.ts`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Type-check**

Run: `pnpm type-check`
Expected: exit 0. Notes if it complains:
- `providerMetadata.minimax` values must be JSON. `width`/`height` may be `undefined`; if the type requires `JSONValue`, replace `undefined` with `null` (e.g. `width: width ?? null`).
- If `Experimental_VideoModelV3` is not found, confirm the import name against `@ai-sdk/provider` exports (it is aliased from `VideoModelV3`).

- [ ] **Step 6: Commit**

```bash
git add src/minimax-video-model.ts src/minimax-video-model.test.ts
git commit -m "feat: add minimax video model with polling (Experimental_VideoModelV3)"
```

---

## Task 9: Wire models into the OpenAI-compatible provider

Add `image`/`imageModel`, `speech`/`speechModel`, `video`/`videoModel` to `createMinimax`. Base is already `…/v1`.

**Files:**
- Modify: `src/minimax-openai-provider.ts`
- Test: `src/minimax-openai-provider.test.ts` (extend)

- [ ] **Step 1: Extend the test**

In `src/minimax-openai-provider.test.ts`, replace the `unsupported model types` block (lines ~65-70) and add new cases. Change the existing `imageModel` throw assertion (it now succeeds) — update that block to:

```ts
  describe('multimodal models', () => {
    it('creates an image model', () => {
      const model = minimax.image('image-01');
      expect(model.provider).toBe('minimax.image');
      expect(model.modelId).toBe('image-01');
      expect(model.specificationVersion).toBe('v3');
    });

    it('creates image models via imageModel alias', () => {
      expect(minimax.imageModel('image-01').provider).toBe('minimax.image');
    });

    it('creates a speech model', () => {
      const model = minimax.speech('speech-2.6-hd');
      expect(model.provider).toBe('minimax.speech');
      expect(model.modelId).toBe('speech-2.6-hd');
    });

    it('creates a video model via both names', () => {
      expect(minimax.video('MiniMax-Hailuo-2.3').provider).toBe('minimax.video');
      expect(minimax.videoModel('MiniMax-Hailuo-2.3').provider).toBe('minimax.video');
    });
  });

  describe('unsupported model types', () => {
    it('throws NoSuchModelError for embeddings', () => {
      expect(() => minimax.embeddingModel('test')).toThrow(/embeddingModel/);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-openai-provider.test.ts`
Expected: FAIL — `minimax.image is not a function` (etc).

- [ ] **Step 3: Implement the wiring**

In `src/minimax-openai-provider.ts`:

(a) Update imports at the top:

```ts
import {
  ImageModelV3,
  SpeechModelV3,
  Experimental_VideoModelV3,
  LanguageModelV3,
  NoSuchModelError,
  ProviderV3,
} from '@ai-sdk/provider';
```

(b) Add model-creation imports:

```ts
import { MinimaxImageModel } from './minimax-image-model';
import { MinimaxImageModelId } from './minimax-image-options';
import { MinimaxSpeechModel } from './minimax-speech-model';
import { MinimaxSpeechModelId } from './minimax-speech-options';
import { MinimaxVideoModel } from './minimax-video-model';
import { MinimaxVideoModelId } from './minimax-video-options';
```

(c) Extend the `MinimaxProvider` interface (after the existing `chat(...)` line):

```ts
  image(modelId: MinimaxImageModelId): ImageModelV3;
  imageModel(modelId: MinimaxImageModelId): ImageModelV3;
  speech(modelId: MinimaxSpeechModelId): SpeechModelV3;
  speechModel(modelId: MinimaxSpeechModelId): SpeechModelV3;
  video(modelId: MinimaxVideoModelId): Experimental_VideoModelV3;
  videoModel(modelId: MinimaxVideoModelId): Experimental_VideoModelV3;
```

(d) Inside `createMinimax`, after `createLanguageModel`, add factories. The shared `modelConfig` reuses the existing `baseURL` + `getHeaders`:

```ts
  const modelConfig = (kind: 'image' | 'speech' | 'video') => ({
    provider: `minimax.${kind}`,
    url: ({ path }: { path: string }) => `${baseURL}${path}`,
    headers: getHeaders,
    fetch: options.fetch,
  });

  const createImageModel = (modelId: MinimaxImageModelId) =>
    new MinimaxImageModel(modelId, modelConfig('image'));
  const createSpeechModel = (modelId: MinimaxSpeechModelId) =>
    new MinimaxSpeechModel(modelId, modelConfig('speech'));
  const createVideoModel = (modelId: MinimaxVideoModelId) =>
    new MinimaxVideoModel(modelId, modelConfig('video'));
```

(e) Replace the existing `provider.imageModel = …` throw stub and add the rest (keep `embeddingModel` throwing):

```ts
  provider.image = createImageModel;
  provider.imageModel = createImageModel;
  provider.speech = createSpeechModel;
  provider.speechModel = createSpeechModel;
  provider.video = createVideoModel;
  provider.videoModel = createVideoModel;

  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-openai-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm type-check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/minimax-openai-provider.ts src/minimax-openai-provider.test.ts
git commit -m "feat: wire image/speech/video into OpenAI-compatible provider"
```

---

## Task 10: Wire models into the Anthropic-compatible provider

Same additions, but derive the `/v1` base (strip `/anthropic`) and use a Bearer header (the `…/v1` endpoints don't accept `x-api-key`). The default export `minimax` is this instance.

**Files:**
- Modify: `src/minimax-anthropic-provider.ts`
- Test: `src/minimax-anthropic-provider.test.ts` (extend)

- [ ] **Step 1: Extend the test**

In `src/minimax-anthropic-provider.test.ts`, replace the `unsupported model types` block (lines ~67-72) with:

```ts
  describe('multimodal models', () => {
    it('creates image, speech, and video models', () => {
      expect(minimaxAnthropic.image('image-01').provider).toBe('minimax.image');
      expect(minimaxAnthropic.speech('speech-2.6-hd').provider).toBe('minimax.speech');
      expect(minimaxAnthropic.video('MiniMax-Hailuo-2.3').provider).toBe('minimax.video');
      expect(minimaxAnthropic.videoModel('MiniMax-Hailuo-2.3').provider).toBe('minimax.video');
    });
  });

  describe('unsupported model types', () => {
    it('throws NoSuchModelError for embeddings', () => {
      expect(() => minimaxAnthropic.embeddingModel('test')).toThrow(/embeddingModel/);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-anthropic-provider.test.ts`
Expected: FAIL — `minimaxAnthropic.image is not a function`.

- [ ] **Step 3: Implement the wiring**

In `src/minimax-anthropic-provider.ts`:

(a) Update the `@ai-sdk/provider` import to add the three model types:

```ts
import {
  ImageModelV3,
  SpeechModelV3,
  Experimental_VideoModelV3,
  LanguageModelV3,
  NoSuchModelError,
  ProviderV3,
} from '@ai-sdk/provider';
```

(b) Add `loadApiKey` is already imported; add model imports + shared helper:

```ts
import { MinimaxImageModel } from './minimax-image-model';
import { MinimaxImageModelId } from './minimax-image-options';
import { MinimaxSpeechModel } from './minimax-speech-model';
import { MinimaxSpeechModelId } from './minimax-speech-options';
import { MinimaxVideoModel } from './minimax-video-model';
import { MinimaxVideoModelId } from './minimax-video-options';
import { deriveV1BaseURL } from './minimax-shared';
```

(c) Extend the `MinimaxAnthropicProvider` interface (after the `chat(...)` line) with the same six method signatures as Task 9c.

(d) Inside `createMinimaxAnthropic`, after `createLanguageModel`, add a Bearer header builder + `/v1` base + factories:

```ts
  const v1BaseURL = deriveV1BaseURL(baseURL);

  const getBearerHeaders = () =>
    withUserAgentSuffix(
      {
        Authorization: `Bearer ${loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: 'MINIMAX_API_KEY',
          description: 'MiniMax API key',
        })}`,
        ...options.headers,
      },
      `minimax-ai-provider`,
    );

  const modelConfig = (kind: 'image' | 'speech' | 'video') => ({
    provider: `minimax.${kind}`,
    url: ({ path }: { path: string }) => `${v1BaseURL}${path}`,
    headers: getBearerHeaders,
    fetch: options.fetch,
  });

  const createImageModel = (modelId: MinimaxImageModelId) =>
    new MinimaxImageModel(modelId, modelConfig('image'));
  const createSpeechModel = (modelId: MinimaxSpeechModelId) =>
    new MinimaxSpeechModel(modelId, modelConfig('speech'));
  const createVideoModel = (modelId: MinimaxVideoModelId) =>
    new MinimaxVideoModel(modelId, modelConfig('video'));
```

(e) Replace the `provider.imageModel = …` throw stub and add the rest (keep `embeddingModel` throwing):

```ts
  provider.image = createImageModel;
  provider.imageModel = createImageModel;
  provider.speech = createSpeechModel;
  provider.speechModel = createSpeechModel;
  provider.video = createVideoModel;
  provider.videoModel = createVideoModel;

  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-anthropic-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a base-derivation assertion**

Append one more test inside the `multimodal models` describe to lock in the `/v1` base for the anthropic instance (it must NOT hit `/anthropic/v1`):

```ts
    it('image model targets the /v1 base, not /anthropic/v1', async () => {
      let capturedUrl = '';
      const custom = createMinimaxAnthropic({
        apiKey: 'k',
        baseURL: 'https://api.minimax.io/anthropic/v1',
        fetch: (async (url: string) => {
          capturedUrl = String(url);
          return new Response(
            JSON.stringify({ data: { image_base64: ['AA'] }, base_resp: { status_code: 0 } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as any,
      });
      await custom.image('image-01').doGenerate({
        prompt: 'x', n: 1, size: undefined, aspectRatio: undefined,
        seed: undefined, providerOptions: {},
      });
      expect(capturedUrl).toBe('https://api.minimax.io/v1/image_generation');
    });
```

Run: `npx vitest --config vitest.node.config.mjs --run src/minimax-anthropic-provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `pnpm type-check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/minimax-anthropic-provider.ts src/minimax-anthropic-provider.test.ts
git commit -m "feat: wire image/speech/video into Anthropic-compatible provider"
```

---

## Task 11: Export new public types (`index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add exports**

Append to `src/index.ts`:

```ts
// Multimodal model id + options types
export type { MinimaxImageModelId, MinimaxImageProviderOptions } from './minimax-image-options';
export type { MinimaxSpeechModelId, MinimaxSpeechProviderOptions } from './minimax-speech-options';
export type { MinimaxVideoModelId, MinimaxVideoProviderOptions } from './minimax-video-options';
```

- [ ] **Step 2: Type-check and build**

Run: `pnpm type-check && pnpm build`
Expected: type-check exit 0; tsup emits `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export multimodal model types"
```

---

## Task 12: Full verification gate

Run the complete suite exactly as CI would. Everything must be green.

- [ ] **Step 1: Type-check**

Run: `pnpm type-check`
Expected: exit 0.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: exit 0 (warnings allowed; no errors). If new `no-explicit-any` *errors* appear in new files, the rule is configured as a warning — confirm exit code is 0. Do not introduce new lint errors.

- [ ] **Step 3: Tests (node + edge)**

Run: `pnpm test`
Expected: PASS in both environments. New files add: shared (12), image (6), speech (5), video (6), provider extensions. Existing 17 still pass.

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: clean `dist/` output, no type errors in the `.d.ts` emit.

- [ ] **Step 5: Commit any final touch-ups** (only if needed)

```bash
git add -A
git commit -m "chore: finalize multimodal support"
```

---

## Task 13: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an "Other Modalities" section**

After the existing API Compatibility section in `README.md`, add:

````markdown
## Image, Speech & Video

All three modalities work on both the default (`minimax`) and `minimaxOpenAI` instances.

### Image generation

```ts
import { minimax } from 'vercel-minimax-ai-provider';
import { experimental_generateImage as generateImage } from 'ai';

const { images } = await generateImage({
  model: minimax.image('image-01'),
  prompt: 'A serene mountain lake at sunrise',
  size: '1024x1024',          // or aspectRatio: '16:9'
  n: 2,
  providerOptions: { minimax: { promptOptimizer: true } },
});
// images[0].uint8Array / images[0].base64
```

### Speech (text-to-speech)

```ts
import { minimax } from 'vercel-minimax-ai-provider';
import { experimental_generateSpeech as generateSpeech } from 'ai';

const { audio } = await generateSpeech({
  model: minimax.speech('speech-2.6-hd'),
  text: '你好，欢迎使用 MiniMax 语音合成。',
  voice: 'male-qn-qingse',     // required by MiniMax; a default is used if omitted
  outputFormat: 'mp3',
  providerOptions: { minimax: { emotion: 'happy', sampleRate: 32000 } },
});
// audio.uint8Array
```

> Voice IDs use MiniMax's catalogue (e.g. descriptive names like `English_Graceful_Lady`).
> See the [voice list](https://platform.minimaxi.com/docs/api-reference/speech-t2a-http).

### Video generation

```ts
import { minimax } from 'vercel-minimax-ai-provider';
import { experimental_generateVideo as generateVideo } from 'ai';

const { videos } = await generateVideo({
  model: minimax.video('MiniMax-Hailuo-2.3'),
  prompt: 'A dog running through a field of flowers',
  duration: 6,                // 6 or 10
  resolution: '1920x1080',    // mapped to MiniMax labels (1080P, 720P, ...)
  providerOptions: { minimax: { pollIntervalMs: 5000, pollTimeoutMs: 600000 } },
});
// videos[0] is a URL-backed video
```

Video generation is asynchronous; the model polls until the task completes and returns
the final video URL. For image-to-video, pass an `image` and use a model that supports
it (e.g. `MiniMax-Hailuo-2.3-Fast` is **image-to-video only** — not valid for text-to-video).
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document image/speech/video usage"
```

---

## Self-Review Checklist (completed during planning)

- **Spec coverage:** Image (§5)→Tasks 3-4; Speech (§6)→Tasks 5-6; Video (§7)→Tasks 7-8; provider wiring both instances (§4)→Tasks 9-10; shared helpers/error handling (§8-9)→Task 2; version upgrade (§11)→Task 1; required-fields gotchas (§10)→folded into model tasks; tests (§12)→every model task + Task 12; README (§14)→Task 13; the pre-existing broken test script (discovered at baseline)→Task 0.
- **Placeholder scan:** No TBD/TODO; every code step shows full code; every run step states an exact command + expected result.
- **Type consistency:** `MinimaxImageModelConfig`/`MinimaxSpeechModelConfig`/`MinimaxVideoModelConfig` use the same `url`/`headers`/`fetch`/`_internal` shape; provider id strings `minimax.image|speech|video` consistent across model files, provider wiring, and tests; `checkMinimaxBaseResp`, `hexToUint8Array`, `mapVideoResolution`, `deriveV1BaseURL` signatures match between Task 2 definition and Tasks 4/6/8/10 usage; `parseProviderOptions` provider key is `'minimax'` everywhere.
- **Known fallbacks documented inline:** warning-type export name (`*CallWarning` vs `SharedV3Warning`), `providerMetadata` JSON-value constraints (`undefined`→`null`), and `Experimental_VideoModelV3` alias — each task's type-check step calls out the fix if the primary name fails.
