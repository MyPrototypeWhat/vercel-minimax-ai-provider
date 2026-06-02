import {
  LanguageModelV3,
  NoSuchModelError,
  ProviderV3,
} from '@ai-sdk/provider';
import {
  FetchFunction,
  withoutTrailingSlash,
} from '@ai-sdk/provider-utils';
import { MinimaxChatModelId } from './minimax-chat-options';
import { MinimaxChatLanguageModel } from './minimax-openai-language-model';
import { createBearerHeaders } from './minimax-shared';

export interface MinimaxProviderSettings {
  /**
MiniMax API key.
*/
  apiKey?: string;
  /**
Base URL for the API calls.
Default: 'https://api.minimax.io/v1'
*/
  baseURL?: string;
  /**
Custom headers to include in the requests.
*/
  headers?: Record<string, string>;
  /**
Custom fetch implementation. You can use it as a middleware to intercept requests,
or to provide a custom fetch implementation for e.g. testing.
*/
  fetch?: FetchFunction;
}

export interface MinimaxProvider extends ProviderV3 {
  /**
Creates a MiniMax model for text generation.
*/
  (modelId: MinimaxChatModelId): LanguageModelV3;

  /**
Creates a MiniMax model for text generation.
*/
  languageModel(modelId: MinimaxChatModelId): LanguageModelV3;

  /**
Creates a MiniMax chat model for text generation.
*/
  chat(modelId: MinimaxChatModelId): LanguageModelV3;
}

export function createMinimax(
  options: MinimaxProviderSettings = {},
): MinimaxProvider {
  const baseURL = withoutTrailingSlash(
    options.baseURL ?? 'https://api.minimax.io/v1',
  ) as string;

  const getHeaders = createBearerHeaders(options);

  const createLanguageModel = (modelId: MinimaxChatModelId) => {
    return new MinimaxChatLanguageModel(modelId, {
      provider: `minimax.chat`,
      url: ({ path }) => `${baseURL}${path}`,
      headers: getHeaders,
      fetch: options.fetch,
    });
  };

  const provider = (modelId: MinimaxChatModelId) =>
    createLanguageModel(modelId);

  provider.languageModel = createLanguageModel;
  provider.chat = createLanguageModel;
  provider.specificationVersion = 'v3' as const;

  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };
  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  };

  return provider;
}

/**
MiniMax provider instance using OpenAI-compatible API.
*/
export const minimax = createMinimax();

/**
MiniMax provider instance using OpenAI-compatible API.
Alias for `minimax` from this module.
*/
export const minimaxOpenAI = createMinimax();
