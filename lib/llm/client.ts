// Thin Gemini client wrapper.
//
// Centralizes:
//   - API key handling (server-side env only — never imported from client code)
//   - JSON-mode generation with a response schema
//   - Hard timeout (so a slow LLM never blocks the demo for >10 s)
//   - PDF-as-input via inlineData (Gemini 1.5+ supports this natively)
//   - Schema validation (zod) before the result leaves this module
//
// The matcher in matchProtocol.ts only calls into this module when the
// deterministic tiers fail — so on the happy demo path, this file isn't even
// touched.

import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { z } from 'zod';

// gemini-1.5-flash was retired from the v1beta endpoint in late 2025. The
// current stable Flash model is gemini-2.5-flash; the alias gemini-flash-latest
// also resolves to it. Pinning the version so prompt-tuning isn't disrupted by
// silent model rotations.
//
// For short structured-extraction calls (the protocol matcher, and anything
// else that wants speed > prose quality) prefer FLASH_LITE_MODEL — it's
// roughly 1.5× faster on output and has a more generous free tier
// (15 RPM / 1000 RPD vs 10 RPM / 250 RPD).
export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const FLASH_LITE_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_TIMEOUT_MS = 10_000;
// Transient upstream failures (timeouts, 5xx) get retried up to this many
// times. Each retry uses a fresh AbortController + a short jittered backoff.
// We deliberately do NOT retry SCHEMA_MISMATCH / INVALID_JSON / NO_API_KEY —
// those won't fix themselves and the caller should fall back deterministically.
const DEFAULT_MAX_ATTEMPTS = 2;

export class LlmClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NO_API_KEY'
      | 'TIMEOUT'
      | 'EMPTY_RESPONSE'
      | 'INVALID_JSON'
      | 'SCHEMA_MISMATCH'
      | 'UPSTREAM_ERROR'
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

export interface LlmAvailability {
  available: boolean;
  reason: string;
}

/** Cheap check the matcher can call before deciding whether to even try the LLM tier. */
export function llmAvailability(): LlmAvailability {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim().length === 0) {
    return {
      available: false,
      reason: 'GEMINI_API_KEY is not set; LLM tiebreaker tier is disabled.',
    };
  }
  return { available: true, reason: 'ok' };
}

export interface GenerateJsonOptions<T> {
  /** The prompt the model sees. Should already have any vocabularies inlined. */
  prompt: string;
  /** Optional binary attachments (e.g. a PDF). Each entry's mimeType is required. */
  attachments?: Array<{ mimeType: string; data: Buffer }>;
  /** OpenAPI-3-ish schema; passed straight to Gemini's responseSchema. */
  responseSchema: object;
  /** Zod schema we validate the parsed JSON against before returning. */
  validate: z.ZodType<T>;
  /** Override the default model. */
  model?: string;
  /** Override the default 10 s timeout. */
  timeoutMs?: number;
  /** 0 for deterministic classification, ~0.4 for narration. */
  temperature?: number;
  /** Override the default retry count for transient errors. Set to 1 to disable retries. */
  maxAttempts?: number;
}

/** Run a JSON-mode generation, validate the result, return the typed object. */
export async function generateJson<T>(opts: GenerateJsonOptions<T>): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new LlmClientError(
      'GEMINI_API_KEY is not set in the environment.',
      'NO_API_KEY'
    );
  }

  const modelName = opts.model ?? DEFAULT_MODEL;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      // The Gemini SDK accepts this as `responseSchema` on supported models.
      // It's typed as `unknown` in the SDK, hence the cast.
      responseSchema: opts.responseSchema as unknown as never,
      temperature: opts.temperature ?? 0,
    },
  });

  const parts: Part[] = [{ text: opts.prompt }];
  for (const att of opts.attachments ?? []) {
    parts.push({
      inlineData: {
        mimeType: att.mimeType,
        data: att.data.toString('base64'),
      },
    });
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  let lastErr: LlmClientError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await singleAttempt<T>({
        model,
        parts,
        timeoutMs,
        validate: opts.validate,
      });
    } catch (err) {
      const wrapped = err instanceof LlmClientError ? err : toLlmError(err);
      lastErr = wrapped;
      if (attempt >= maxAttempts || !isRetryable(wrapped)) {
        throw wrapped;
      }
      // Jittered backoff: 250 ms, 500 ms, 1 s, ... with up to 100 ms jitter.
      // Keeps the demo responsive while still smoothing brief 503 storms.
      const base = 250 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 100);
      await sleep(base + jitter);
    }
  }
  // Should be unreachable; the loop either returns or throws above.
  throw lastErr ?? new LlmClientError('Gemini call failed without an error.', 'UPSTREAM_ERROR');
}

interface SingleAttemptArgs<T> {
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>;
  parts: Part[];
  timeoutMs: number;
  validate: z.ZodType<T>;
}

async function singleAttempt<T>({
  model,
  parts,
  timeoutMs,
  validate,
}: SingleAttemptArgs<T>): Promise<T> {
  // AbortController so a timed-out call also tells the SDK to stop holding
  // open the underlying fetch (vs. orphaning it via plain Promise.race).
  // Per the SDK docs, this is client-side cancellation only — Google still
  // bills for any tokens already generated upstream — but it frees our local
  // sockets and prevents `unhandledRejection` noise after a timeout.
  const controller = new AbortController();
  const result = await withTimeout(
    model.generateContent(
      { contents: [{ role: 'user', parts }] },
      { signal: controller.signal }
    ),
    timeoutMs,
    controller
  );

  const text = result.response.text();
  if (!text || text.trim().length === 0) {
    throw new LlmClientError('Gemini returned an empty response.', 'EMPTY_RESPONSE');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LlmClientError(
      `Gemini returned invalid JSON: ${(err as Error).message}. Raw: ${truncate(text, 200)}`,
      'INVALID_JSON'
    );
  }

  const validated = validate.safeParse(parsed);
  if (!validated.success) {
    throw new LlmClientError(
      `Gemini response failed schema validation: ${validated.error.message}`,
      'SCHEMA_MISMATCH'
    );
  }
  return validated.data;
}

// ----- helpers -----

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller?: AbortController
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new LlmClientError(`Gemini call timed out after ${ms} ms.`, 'TIMEOUT'));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Map an unknown thrown value into a typed LlmClientError so the retry/return
 *  surface stays uniform. We classify based on substrings the Gemini SDK is
 *  known to put in `Error.message` for HTTP-level failures (it doesn't expose
 *  a structured status code). */
function toLlmError(err: unknown): LlmClientError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b5\d{2}\b/.test(msg) || /unavailable|overloaded|deadline/i.test(msg)) {
    return new LlmClientError(`Gemini upstream error: ${msg}`, 'UPSTREAM_ERROR');
  }
  if (/abort/i.test(msg)) {
    return new LlmClientError(`Gemini call aborted: ${msg}`, 'TIMEOUT');
  }
  return new LlmClientError(`Gemini call failed: ${msg}`, 'UPSTREAM_ERROR');
}

function isRetryable(err: LlmClientError): boolean {
  return err.code === 'TIMEOUT' || err.code === 'UPSTREAM_ERROR' || err.code === 'EMPTY_RESPONSE';
}
