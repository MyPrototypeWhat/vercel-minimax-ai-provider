# Design: MiniMax Provider — Speech / Image / Video Support + AI SDK Upgrade

Date: 2026-06-02
Branch: `feat/multimodal-speech-image-video`

## 1. Goal & Context

The `vercel-minimax-ai-provider` package (a Vercel AI SDK community provider for the
MiniMax / MiniMax platform, API base `https://api.minimax.io`) currently supports only
language models. This work adds three new modalities as **standard AI SDK models** and
upgrades the AI SDK dependencies to latest stable.

Scope (confirmed): **core three modalities only** — Speech (TTS), Image, Video.
Out of scope: music generation, voice cloning, voice design (MiniMax has these but they
are not standard AI SDK interfaces). MiniMax has no STT, so no `TranscriptionModelV3`.

The AI SDK latest stable (`@ai-sdk/provider@3.0.x`) natively provides `ImageModelV3`,
`SpeechModelV3`, and `Experimental_VideoModelV3`, so all three are implemented as
first-class models consumable via `generateImage` / `generateSpeech` /
`experimental_generateVideo`.

All technical claims below were independently verified against the published npm
tarballs and the official MiniMax docs (`platform.minimaxi.com/docs`) by parallel review
agents. Corrections from that review are folded in and marked `[review]`.

## 2. Existing Architecture (unchanged parts)

Two provider instances exist:
- `minimaxOpenAI` (`createMinimax`) — OpenAI-compatible, base `https://api.minimax.io/v1`.
- `minimaxAnthropic` (`createMinimaxAnthropic`) — Anthropic-compatible, base
  `https://api.minimax.io/anthropic/v1`. This is **also** the default export `minimax`.

Language model implementations (`minimax-openai-language-model.ts`, the anthropic
internal model) are **not changed** by this work.

## 3. File Structure

New files (follow existing `minimax-*` kebab naming):

```
src/
  minimax-image-model.ts          # MinimaxImageModel implements ImageModelV3
  minimax-image-options.ts        # MinimaxImageModelId + provider options schema
  minimax-image-model.test.ts
  minimax-speech-model.ts         # MinimaxSpeechModel implements SpeechModelV3
  minimax-speech-options.ts       # MinimaxSpeechModelId + provider options schema
  minimax-speech-model.test.ts
  minimax-video-model.ts          # MinimaxVideoModel implements Experimental_VideoModelV3
  minimax-video-options.ts        # video model ids + provider options schema (poll config)
  minimax-video-model.test.ts
  minimax-shared.ts               # shared helpers: base_resp check, /v1 base derivation
```

Modified files:
- `src/minimax-openai-provider.ts` — real `imageModel`; add `image`/`speech`/`speechModel`/`video`/`videoModel`.
- `src/minimax-anthropic-provider.ts` — same additions; derive `/v1` base + Bearer auth for non-LLM models.
- `src/index.ts` — export new model id types and provider option types.
- `package.json` — dependency bumps.
- `README.md` — usage sections for the three modalities.

## 4. Provider Wiring

Both provider instances expose all three modalities. **Critical:** speech/image/video
endpoints live under `…/v1` (not `…/anthropic/v1`) and use `Authorization: Bearer`
(not the anthropic `x-api-key`). [review-confirmed: all /v1 endpoints are Bearer]

- `minimaxOpenAI`: base is already `…/v1`; reuse directly.
- `minimaxAnthropic`: LLM keeps `…/anthropic/v1`; non-LLM models derive the `/v1` base by
  stripping the `/anthropic` segment (helper in `minimax-shared.ts`). Auth uses a Bearer
  header built from the same API key (env `MINIMAX_API_KEY`), **not** `x-api-key`.

`[review B2]` `ProviderV3` declares `languageModel`, `embeddingModel`, `imageModel`
(required) and optional `speechModel?` / `transcriptionModel?`. It has **no** `video`.
So:
- `imageModel` — implement (required member).
- `speechModel` + ergonomic `speech` alias — implement (satisfies optional member).
- `video` + `videoModel` — add as **custom properties on our own interface** that
  `extends ProviderV3` (the `@ai-sdk/fal` pattern). `NoSuchModelError`'s `modelType`
  union does include `'videoModel'`, so unknown-id throws are supported.
- `embeddingModel` — keep throwing `NoSuchModelError` (MiniMax has no embeddings).

Provider interface shape (both instances):

```ts
interface MinimaxProvider extends ProviderV3 {
  (modelId): LanguageModelV3;
  languageModel(modelId): LanguageModelV3;
  chat(modelId): LanguageModelV3;
  imageModel(modelId: MinimaxImageModelId): ImageModelV3;
  image(modelId: MinimaxImageModelId): ImageModelV3;            // alias
  speechModel(modelId: MinimaxSpeechModelId): SpeechModelV3;
  speech(modelId: MinimaxSpeechModelId): SpeechModelV3;         // alias
  videoModel(modelId: MinimaxVideoModelId): Experimental_VideoModelV3;
  video(modelId: MinimaxVideoModelId): Experimental_VideoModelV3;
}
```

## 5. Image Model — `MinimaxImageModel implements ImageModelV3`

- Endpoint: `POST {v1}/image_generation`
- Model ids: `'image-01' | 'image-01-live' | (string & {})`
- `maxImagesPerCall = 9` and send `n` in body → `generateImage` issues **one** request for
  n ≤ 9 (otherwise it fans out into n calls). `[review]`
- `specificationVersion = 'v3'`

Request mapping:

| AI SDK call option | MiniMax body |
| --- | --- |
| `prompt` (string \| undefined — handle undefined) | `prompt` (max 1500 chars) |
| `n` | `n` (1–9) |
| `size` (`{w}x{h}`) | split → `width` / `height` (512–2048, ×8; image-01 only) |
| `aspectRatio` (`{w}:{h}`) | `aspect_ratio` |
| `seed` | `seed` |
| `providerOptions.minimax.promptOptimizer` | `prompt_optimizer` (only if provided; default false) |
| `providerOptions.minimax.style` | `style` (image-01-live only) |
| `providerOptions.minimax.aigcWatermark` | `aigc_watermark` |
| `providerOptions.minimax.subjectReference` | `subject_reference` (i2i) |

- **Always send `response_format: 'base64'`** (API default is `url`). `[review]`
- `[review]` `size` and `aspect_ratio` are mutually exclusive server-side (aspect_ratio
  wins). If both are provided, send `size` only and push `{type:'unsupported',
  feature:'aspectRatio', details:'size takes precedence; aspect_ratio ignored'}`.
- `[review]` `subject_reference` is an **array of objects**:
  `[{ type: 'character', image_file: '<url | data:image/...;base64,...>' }]` — not a bare
  string. The provider option type reflects this.

Response mapping:
- Success requires `base_resp.status_code === 0` (HTTP may be 200 on business errors —
  see §8). Base64 array at **`data.image_base64`**. `[review-confirmed exact field]`
- Return: `{ images: data.image_base64, warnings, response, providerMetadata? }`.
- `[review D3]` If returning `providerMetadata`, the `ImageModelV3ProviderMetadata` shape
  is `Record<string, { images: JSONArray } & JSONValue>` and the `images` array length
  **must equal** the number of generated images, else `generateImage` throws. To stay
  safe we either (a) return per-image metadata in a correctly-sized `images` array, or
  (b) omit `providerMetadata`. Default: build `images` as one `{}` per returned image and
  attach `metadata` (success/failed counts) under a sibling key only if length-safe.
  When in doubt, omit.

## 6. Speech Model — `MinimaxSpeechModel implements SpeechModelV3`

- Endpoint: `POST {v1}/t2a_v2` (note `_v2`)
- Model ids: `'speech-2.8-hd' | 'speech-2.8-turbo' | 'speech-2.6-hd' | 'speech-2.6-turbo'
  | 'speech-02-hd' | 'speech-02-turbo' | (string & {})`
- `specificationVersion = 'v3'`

Request mapping:

| AI SDK call option | MiniMax body |
| --- | --- |
| `text` | `text` (max 10000 chars) |
| `voice` | `voice_setting.voice_id` |
| `speed` | `voice_setting.speed` |
| `outputFormat` (mp3/wav/flac/pcm) | `audio_setting.format` |
| `language` | `language_boost` |
| `providerOptions.minimax.{vol,pitch,emotion}` | `voice_setting.{vol,pitch,emotion}` |
| `providerOptions.minimax.{sampleRate,bitrate,channel}` | `audio_setting.{sample_rate,bitrate,channel}` |
| `providerOptions.minimax.pronunciationDict` | `pronunciation_dict` |

- `[review]` `voice_setting.voice_id` is **required** by the API. Provide a default
  (`male-qn-qingse`, present in docs examples) overridable via `voice`. Note in README that
  the canonical voice list uses newer descriptive names (e.g. `English_Graceful_Lady`);
  the default is a best-effort legacy value.
- **Always send `output_format: 'hex'`**, `stream: false`. `[review]`
- Two distinct "format" concepts, keep separate: `audio_setting.format` (container,
  from AI SDK `outputFormat`) vs `output_format:'hex'` (response encoding, forced).

Response mapping:
- Success requires `base_resp.status_code === 0`. `data.audio` is a **hex** string.
- **Decode hex → `Uint8Array`** and return as `audio`. `[review B3 — critical]` If a raw
  `string` is returned, the SDK interprets it as **base64**, silently corrupting audio.
  Returning `Uint8Array` sidesteps this entirely. Decode via `Buffer.from(hex, 'hex')`
  (Node) with an edge-safe manual fallback, or a small hex→bytes helper in shared.
- Return: `{ audio: Uint8Array, warnings, request?, response, providerMetadata? }`.
  Put `extra_info` (audio_length, sample_rate, size) under `providerMetadata.minimax`.

## 7. Video Model — `MinimaxVideoModel implements Experimental_VideoModelV3`

`[review B1]` There is **no** `VideoModelV3` / `generateVideo` export. Use:
```ts
import { Experimental_VideoModelV3, Experimental_VideoModelV3CallOptions,
         Experimental_VideoModelV3File } from '@ai-sdk/provider';
// users call: import { experimental_generateVideo } from 'ai';
```

Async three-step flow (polling inside `doGenerate`, the fal/luma pattern):
1. `POST {v1}/video_generation` → `task_id`
2. `GET {v1}/query/video_generation?task_id=…` → poll `status`
3. `GET {v1}/files/retrieve?file_id=…` → `file.download_url`

- Model ids (t2v vs i2v differ — `[review B1]`):
  - text-to-video valid: `'MiniMax-Hailuo-2.3' | 'MiniMax-Hailuo-02'`
  - image-to-video also allows: `'MiniMax-Hailuo-2.3-Fast'`
  - Type: `MinimaxVideoModelId = 'MiniMax-Hailuo-2.3' | 'MiniMax-Hailuo-2.3-Fast' |
    'MiniMax-Hailuo-02' | (string & {})`. **`-Fast` must NOT be used for t2v** — if used
    without an `image`, push a warning / surface the API error clearly. Document in README.
- `maxVideosPerCall = 1`; `specificationVersion = 'v3'`. `n > 1` → warning (only 1 made).

Request mapping:

| AI SDK call option | MiniMax body |
| --- | --- |
| `prompt` (string \| undefined) | `prompt` (max 2000 chars) |
| `image` (i2v) | `first_frame_image` (public URL or `data:image/…;base64,…`) |
| `duration` | `duration` (6 or 10 only) |
| `resolution` (`{w}x{h}`) | `resolution` mapped to `'720P'`/`'768P'`/`'1080P'`/`'512P'` strings |
| `seed` | `seed` |
| `aspectRatio` / `fps` | unsupported → warnings |
| `providerOptions.minimax.{promptOptimizer,fastPretreatment,aigcWatermark,callbackUrl}` | `prompt_optimizer` (default true), `fast_pretreatment`, `aigc_watermark`, `callback_url` |

- `[review]` `resolution` is a **string label**, not WxH. Use a `RESOLUTION_MAP`
  (`1080x1920`/`1920x1080` → `'1080P'`, etc.; fall through to passthrough for unknown).
- `[review]` `first_frame_image` accepts URL or base64 data URI; convert AI SDK
  `image` file via `convertImageModelFileToDataUri` / equivalent.

Polling logic (mirrors `@ai-sdk/fal`):
```
create → task_id (throw if missing)
loop:
  GET query?task_id
  status === 'Success' → break
  status === 'Fail'    → throw AISDKError (include task_id)
  elapsed > pollTimeoutMs → throw timeout AISDKError
  delay(pollIntervalMs, { abortSignal })   // pass through abort
GET files/retrieve?file_id → download_url
```
- `status` strings are **case-sensitive**: `Preparing`, `Queueing`, `Processing`,
  `Success`, `Fail`. `[review-confirmed casing]`
- Defaults: `pollIntervalMs = 5000`, `pollTimeoutMs = 600000` (10 min); overridable via
  `providerOptions.minimax.{pollIntervalMs,pollTimeoutMs}`.
- Return `{ videos: [{ type:'url', url: download_url, mediaType:'video/mp4' }], warnings,
  response, providerMetadata: { minimax: { taskId, fileId, width, height } } }`.
- `[review]` **Do not download bytes** — for a `url` result the SDK fetches them itself.

## 8. Error Handling (shared)

- Reuse `defaultMinimaxErrorStructure` + `createJsonErrorResponseHandler` for HTTP-layer
  errors (all three models).
- `[review]` MiniMax returns HTTP 200 with a non-zero `base_resp.status_code` for business
  errors. Add a shared `checkMinimaxBaseResp(baseResp, { url })` in `minimax-shared.ts`
  that throws `APICallError` when `status_code !== 0`. Call it in every model after parse.
- Video Fail/timeout → `AISDKError` carrying `task_id` for debuggability.

## 9. Shared Helpers (`minimax-shared.ts`)

- `deriveV1BaseURL(baseURL)` — strip a trailing `/anthropic` segment so the anthropic
  instance's non-LLM models target `…/v1`.
- `checkMinimaxBaseResp(baseResp, ctx)` — business-error guard (§8).
- `hexToUint8Array(hex)` — edge-safe hex decode for speech.
- `RESOLUTION_MAP` + `mapResolution(size)` for video.
- Optional `groupId` passthrough: if a `groupId` is configured, append `?GroupId=…` to the
  speech/file endpoints. `[review C1]` Not required for the international
  `api.minimax.io` host per current docs, but the legacy host historically required it —
  cheap defensive option, off by default.

## 10. Required Fields / Gotchas Checklist (per `@ai-sdk/provider@3.0.10`)

Apply to all three models:
- `warnings: SharedV3Warning[]` is **required** (return `[]` at minimum). V3 warning shape
  is `{ type:'unsupported', feature, details? }` — field is `feature`, not V2's `setting`.
- `response` is **required**: `{ timestamp: Date, modelId: string, headers }`. Wire a
  `_internal.currentDate` hook for deterministic tests (every reference provider does).
- `specificationVersion: 'v3'` on every model.
- `ImageModelV3CallOptions.providerOptions` / video's are non-optional but the SDK passes
  `{}` when omitted — `parseProviderOptions` handles it.
- Image `providerMetadata.images` invariant — see §5.

## 11. Version Upgrade (latest stable, `^` ranges)

`package.json` dependencies:
```
@ai-sdk/anthropic      3.0.0-beta.71  → ^3.0.81
@ai-sdk/provider       3.0.0-beta.23  → ^3.0.10
@ai-sdk/provider-utils 4.0.0-beta.41  → ^4.0.27
```
- `[review — SAFE]` All in-place same-major (3→3, 4→4, 3→3) beta→superseding-stable
  upgrades. The betas sort before the stables.
- `@ai-sdk/anthropic@3.0.81` keeps the `/internal` subpath export and a compatible
  `AnthropicMessagesLanguageModel(modelId, config)` constructor — the existing
  `minimax-anthropic-provider.ts` call (provider, baseURL, headers, fetch, generateId,
  supportedUrls) still compiles unchanged.
- Transitive deps pin exactly to provider 3.0.10 / provider-utils 4.0.27 → single resolved
  copy, no skew. All 19 helpers used (incl. new `getFromApi`, `delay`, `convertToBase64`)
  present. zod v4 (`zod/v4`) still compatible. No breaking changes in any upgrade window.
- devDependencies unchanged (per scope decision).
- After bump: regenerate `pnpm-lock.yaml`, run type-check.

## 12. Testing

One test file per model, mocked `fetch` (existing tests already use `vi.fn()`); inject
`_internal.currentDate` for stable timestamps.

- **Image**: n/size→width,height & aspect_ratio mapping; forced `response_format:base64`;
  `data.image_base64` → `images`; size+aspectRatio conflict warning; `base_resp!=0` throws;
  `providerMetadata.images` length matches (or omitted).
- **Speech**: voice/speed/format mapping; forced `output_format:hex`; **hex→Uint8Array**
  decode correctness; default voice_id; `base_resp!=0` throws.
- **Video**: create body; poll until `Success`; `Fail` throws; timeout throws (mock
  interval/time so tests don't really wait); `resolution` map; i2v `image`→
  `first_frame_image`; returns `{type:'url'}`; `-Fast` t2v warning.
- **Providers**: both instances build all three model types; anthropic instance's non-LLM
  models use the derived `…/v1` base + Bearer header; `embeddingModel` still throws
  `NoSuchModelError`.

## 13. Delivery & Verification

- Work on branch `feat/multimodal-speech-image-video` (not main).
- Do **not** publish (no changeset/publish changes). Code + green tests only.
- Final gate (all must pass):
  `pnpm install` → `pnpm type-check` → `pnpm test` → `pnpm lint` → `pnpm build`.

## 14. README

Add three usage sections: `generateImage` (with size/aspectRatio + base64 output),
`generateSpeech` (voice + providerOptions emotion/format), and
`experimental_generateVideo` (i2v via `image`, poll config via providerOptions). Note the
t2v vs i2v model-id distinction and the `-Fast` i2v-only caveat.
