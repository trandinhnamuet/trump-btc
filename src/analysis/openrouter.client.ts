import { Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Client mỏng cho OpenRouter, tách khỏi mọi logic chấm điểm.
 *
 * Điểm quan trọng: nó PHÂN LOẠI lỗi thay vì gộp tất cả thành "thất bại".
 * Ở v1, một response bị cắt giữa chừng (finish_reason=length) trông y hệt một
 * response JSON hỏng, và cả hai đều kích hoạt fallback sang model khác. Hệ quả:
 * các model viết tiếng Việt dài dòng bị loại một cách hệ thống, không phải vì
 * chúng dở mà vì chúng nói nhiều. Ở đây truncation là một loại lỗi riêng, có log
 * riêng, và được xử lý bằng cách nâng token chứ không phải đổi model.
 */

export type FailureKind =
  | 'rate_limit'
  | 'not_found'
  | 'truncated'
  | 'empty'
  | 'provider_error'
  | 'bad_request'
  | 'timeout'
  | 'http_error';

export class OpenRouterError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  images?: string[];
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
}

export interface ChatResponse {
  raw: string;
  elapsedMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);
  private readonly url = 'https://openrouter.ai/api/v1/chat/completions';

  constructor(private readonly apiKey: string) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startMs = Date.now();
    const hasImages = (req.images?.length ?? 0) > 0;

    let response: any;
    try {
      response = await axios.post(
        this.url,
        {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            {
              role: 'user',
              content: hasImages
                ? [
                    { type: 'text', text: req.user },
                    ...req.images!.slice(0, 4).map(url => ({ type: 'image_url', image_url: { url } })),
                  ]
                : req.user,
            },
          ],
          temperature: req.temperature,
          max_tokens: req.maxTokens,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://github.com/trump-btc',
            'X-Title': 'Trump BTC Signal Bot',
          },
          timeout: req.timeoutMs ?? 45_000,
        },
      );
    } catch (err: any) {
      throw this.classifyTransportError(err, req.model);
    }

    // Một số provider trả HTTP 200 kèm {error: ...} thay vì {choices: [...]}
    if (response.data?.error && !response.data?.choices?.length) {
      const msg = response.data.error?.message ?? 'provider error';
      throw new OpenRouterError('provider_error', `${req.model}: ${String(msg).substring(0, 120)}`);
    }

    const choice = response.data?.choices?.[0];
    const message = choice?.message;

    // Model reasoning (laguna, nemotron-ultra) đôi khi để content=null và đặt kết quả trong 'reasoning'
    let raw: string = message?.content ?? '';
    if (!raw?.trim() && message?.reasoning) raw = String(message.reasoning);

    const elapsedMs = Date.now() - startMs;

    if (choice?.finish_reason === 'length') {
      throw new OpenRouterError(
        'truncated',
        `${req.model} bị cắt ở max_tokens=${req.maxTokens} sau ${elapsedMs}ms ` +
          `(${raw.length} ký tự). Nâng max_tokens thay vì đổi model.`,
      );
    }

    if (!raw?.trim()) {
      throw new OpenRouterError('empty', `${req.model} trả về content rỗng sau ${elapsedMs}ms`);
    }

    return {
      raw,
      elapsedMs,
      promptTokens: response.data?.usage?.prompt_tokens,
      completionTokens: response.data?.usage?.completion_tokens,
    };
  }

  private classifyTransportError(err: any, model: string): OpenRouterError {
    const status = err?.response?.status;
    const body = err?.response?.data?.error?.message ?? '';
    const meta = err?.response?.data?.error?.metadata?.raw ?? '';

    if (!status) return new OpenRouterError('timeout', `${model}: timeout hoặc lỗi mạng`);

    if (status === 429) {
      if (String(body).includes('free-models-per-day')) {
        return new OpenRouterError('rate_limit', `${model}: hết quota free tier trong ngày`, 429);
      }
      if (meta || String(body).includes('upstream')) {
        return new OpenRouterError('rate_limit', `${model}: nhà cung cấp quá tải`, 429);
      }
      return new OpenRouterError('rate_limit', `${model}: rate limit`, 429);
    }

    if (status === 404) return new OpenRouterError('not_found', `${model}: không tồn tại`, 404);

    if (status === 400) {
      if (String(body).includes('image')) {
        return new OpenRouterError('bad_request', `${model}: ảnh bị từ chối`, 400);
      }
      return new OpenRouterError('bad_request', `${model}: ${String(body).substring(0, 80)}`, 400);
    }

    return new OpenRouterError('http_error', `${model}: HTTP ${status}`, status);
  }
}

/**
 * Trích JSON từ response text.
 * Xử lý: <think> blocks, markdown fences, văn bản thừa sau dấu } đóng.
 */
export function extractJson(raw: string): any | null {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```json\s*\n?/im, '')
    .replace(/\n?```\s*$/im, '')
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    /* thử brace matching bên dưới */
  }

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.substring(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
