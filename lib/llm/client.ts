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
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 10_000;

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

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: opts.model ?? DEFAULT_MODEL,
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
  const result = await withTimeout(
    model.generateContent({ contents: [{ role: 'user', parts }] }),
    timeoutMs
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

  const validated = opts.validate.safeParse(parsed);
  if (!validated.success) {
    throw new LlmClientError(
      `Gemini response failed schema validation: ${validated.error.message}`,
      'SCHEMA_MISMATCH'
    );
  }
  return validated.data;
}

// ----- helpers -----

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LlmClientError(`Gemini call timed out after ${ms} ms.`, 'TIMEOUT')),
      ms
    );
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
