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
 * MiniMax's `language_boost` expects full English language names (e.g. "English",
 * "Chinese") or "auto", whereas the AI SDK `language` field is an ISO 639-1 code
 * (e.g. "en", "zh") or "auto". Map common ISO codes to MiniMax names. Returns
 * `undefined` for an unknown code so the caller can warn and omit the field.
 */
const LANGUAGE_BOOST_MAP: Record<string, string> = {
  auto: 'auto',
  zh: 'Chinese',
  yue: 'Chinese,Yue',
  en: 'English',
  ar: 'Arabic',
  ru: 'Russian',
  es: 'Spanish',
  fr: 'French',
  pt: 'Portuguese',
  de: 'German',
  tr: 'Turkish',
  nl: 'Dutch',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ja: 'Japanese',
  it: 'Italian',
  ko: 'Korean',
  th: 'Thai',
  pl: 'Polish',
  ro: 'Romanian',
  el: 'Greek',
  cs: 'Czech',
  fi: 'Finnish',
  hi: 'Hindi',
};

export function mapLanguageBoost(language: string): string | undefined {
  if (language === 'auto') return 'auto';
  return LANGUAGE_BOOST_MAP[language.toLowerCase()];
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
