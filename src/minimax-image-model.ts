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

    const url = this.config.url({
      path: '/image_generation',
      modelId: this.modelId,
    });

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
