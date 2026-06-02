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
