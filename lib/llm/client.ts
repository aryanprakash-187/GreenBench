// Thin Anthropic (Claude) client wrapper.
//
// Centralizes:
//   - API key handling (server-side env only — ANTHROPIC_API_KEY; never
//     imported from client code)
//   - JSON generation: the prompts already instruct "return JSON only", and we
//     validate the parsed result with zod before anything leaves this module.
//     We deliberately do NOT use provider-side structured outputs yet — the
//     existing response schemas are OpenAPI-flavored (`nullable: true`, array
//     length caps) which aren't valid JSON Schema for Anthropic, and zod is the
//     authoritative validator either way. Adopting `output_config.format` is a
//     clean follow-up once the schemas are ported to plain JSON Schema.
//   - Hard timeout via AbortController (so a slow model never blocks a request)
//   - PDF-as-input via Anthropic `document` content blocks
//   - Retry with backoff for transient / rate-limit errors
//
// Migrated from Gemini to Claude (ChangesToBeMadeForPilot.md §8): the whole LLM
// pipeline (parser, narrator, matcher) now runs on Anthropic. Default model is
// Sonnet 4.6 — the best speed/intelligence balance and strong on the dense
// numerical-table extraction that is the parser's bottleneck.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// Sonnet 4.6: pipeline default. Strong document understanding, 1M context,
// supports PDF input. Switch the parser to a higher tier (e.g. Opus) by
// passing `model` from the caller if accuracy ever needs it.
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
// Cheap/fast tier for short structured calls (the legacy matcher tiebreaker).
export const FLASH_LITE_MODEL = 'claude-haiku-4-5';

const DEFAULT_TIMEOUT_MS = 10_000;
// Transient upstream failures (timeouts, 5xx, overloaded) get retried up to
// this many times. We deliberately do NOT retry SCHEMA_MISMATCH / INVALID_JSON
// / NO_API_KEY — those won't fix themselves and the caller should fall back
// deterministically.
const DEFAULT_MAX_ATTEMPTS = 2;
// Output ceiling. Comfortably covers a ~60-reagent parse draft or a full
// week-plan narration; callers can override per request.
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// USD per 1M tokens, for the per-request cost line we print to the server
// terminal. Keep in sync with the models we actually call.
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-opus-4-8': { in: 5, out: 25 },
};

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
      | 'RATE_LIMITED',
    /** Raw model text + a short failure reason, populated for INVALID_JSON /
     *  SCHEMA_MISMATCH so the Layer-4 repair pass can show the model exactly
     *  what it returned and why it was rejected. */
    public readonly repair?: { responseText: string; reason: string }
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

export interface LlmAvailability {
  available: boolean;
  reason: string;
}

/** Cheap check callers can use before deciding whether to even try the LLM. */
export function llmAvailability(): LlmAvailability {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    return {
      available: false,
      reason: 'ANTHROPIC_API_KEY is not set; LLM tiers are disabled.',
    };
  }
  return { available: true, reason: 'ok' };
}

export interface GenerateJsonOptions<T> {
  /** The prompt the model sees. Should already have any vocabularies inlined
   *  and a "return JSON only" instruction. */
  prompt: string;
  /** Static instructions to send as a cached `system` block. Prompt caching
   *  (Anthropic `cache_control: ephemeral`) means this large, request-invariant
   *  text is billed at the full input rate only on the first call within the
   *  ~5-minute cache window, then ~0.1× on every subsequent call. Put the bulky
   *  unchanging instructions here and keep `prompt` to the small per-request
   *  dynamic part (filename, document excerpt). Min cacheable prefix is ~1024
   *  tokens; shorter systems simply aren't cached, which is harmless. */
  system?: string;
  /** When true, also place a cache breakpoint on the LAST user content block
   *  (the document / text excerpt). This caches the full prefix — system +
   *  prompt + document — so re-parsing the *same* upload within the window
   *  (e.g. two labmates uploading an identical handbook) is a near-total cache
   *  hit, not a second full-price parse. */
  cacheUserPrefix?: boolean;
  /** Layer 1 — structured outputs. When set, the JSON Schema is sent via
   *  Anthropic `output_config.format` so the model is grammar-constrained to
   *  this shape at generation time (not just asked + checked). On a provider
   *  that doesn't support the parameter at all we detect the rejection once and
   *  fall back to prompt-only generation; zod still validates either way. */
  jsonSchema?: { schema: Record<string, unknown> };
  /** Layer 4 — one-shot repair. When true, an INVALID_JSON / SCHEMA_MISMATCH
   *  result triggers a single corrective turn: the model is shown its own bad
   *  output plus the validation error and asked to return fixed JSON. */
  repairOnInvalid?: boolean;
  /** Optional binary attachments (e.g. a PDF). Sent as Anthropic `document`
   *  content blocks. Each entry's mimeType should be application/pdf. */
  attachments?: Array<{ mimeType: string; data: Buffer }>;
  /** Accepted for backward-compat with the former Gemini call sites; currently
   *  ignored. Correctness is enforced by `validate` (zod) after parsing. */
  responseSchema?: object;
  /** Zod schema we validate the parsed JSON against before returning. */
  validate: z.ZodType<T>;
  /** Override the default model. */
  model?: string;
  /** Override the default 10 s timeout. */
  timeoutMs?: number;
  /** 0 for deterministic extraction/classification, ~0.4 for narration. */
  temperature?: number;
  /** Override the default retry count for transient errors. Set to 1 to disable. */
  maxAttempts?: number;
  /** Override the default output-token ceiling. */
  maxOutputTokens?: number;
}

/** Run a JSON generation, validate the result, return the typed object. */
export async function generateJson<T>(opts: GenerateJsonOptions<T>): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmClientError(
      'ANTHROPIC_API_KEY is not set in the environment.',
      'NO_API_KEY'
    );
  }

  // maxRetries: 0 — we run our own retry/backoff loop below (it distinguishes
  // rate-limit backoff from generic transient backoff).
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  const content: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: opts.prompt },
  ];
  for (const att of opts.attachments ?? []) {
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        // Anthropic document blocks accept PDFs natively. Callers only attach
        // PDFs here (non-PDF inputs flow through the text path instead).
        media_type: 'application/pdf',
        data: att.data.toString('base64'),
      },
    });
  }

  // Cache breakpoint on the last user block (document / excerpt): caches the
  // whole prefix incl. system, so an identical re-upload within the window is
  // a cache read, not a fresh full-price parse.
  if (opts.cacheUserPrefix && content.length > 0) {
    // The last block is always a text or document block (both support
    // cache_control); the union also includes thinking blocks which don't, so
    // assert the cacheable shape rather than widening the whole array's type.
    (
      content[content.length - 1] as { cache_control?: Anthropic.CacheControlEphemeral }
    ).cache_control = { type: 'ephemeral' };
  }

  // Static instructions as a separately-cached system block: reused across
  // *different* uploads (the instructions don't change), independent of the
  // per-upload document cache above.
  const system: Anthropic.TextBlockParam[] | undefined = opts.system
    ? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
    : undefined;

  const modelName = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  // The conversation grows by two turns (assistant bad-output + user fix-it)
  // each time a Layer-4 repair fires; the cached prefix in messages[0] is
  // untouched, so repair turns still benefit from prompt caching.
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
  let repairsLeft = opts.repairOnInvalid ? 1 : 0;

  let lastErr: LlmClientError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await singleAttempt<T>({
        client,
        model: modelName,
        messages,
        system,
        jsonSchema: opts.jsonSchema,
        temperature: opts.temperature ?? 0,
        maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        timeoutMs,
        validate: opts.validate,
      });
    } catch (err) {
      const wrapped = err instanceof LlmClientError ? err : toLlmError(err);
      lastErr = wrapped;

      // Layer 4 — one-shot repair. Validation failures aren't normally retried
      // (they don't fix themselves), but a corrective turn often does: show the
      // model its own output and the exact error and ask for fixed JSON. Costs
      // one attempt and one repair budget; falls through to the throw below if
      // it still fails.
      const repairable =
        wrapped.code === 'SCHEMA_MISMATCH' || wrapped.code === 'INVALID_JSON';
      if (repairable && repairsLeft > 0 && wrapped.repair && attempt < maxAttempts) {
        repairsLeft--;
        messages.push({ role: 'assistant', content: wrapped.repair.responseText });
        messages.push({
          role: 'user',
          content:
            `Your previous response could not be used: ${wrapped.repair.reason}\n\n` +
            'Return ONLY a corrected JSON object that fixes exactly those issues ' +
            'and conforms to the required schema. No prose, no code fences, no apology.',
        });
        console.warn('[claude] repair attempt: re-prompting with validation error');
        continue;
      }

      if (attempt >= maxAttempts || !isRetryable(wrapped)) {
        throw wrapped;
      }
      // Rate limit (429): wait 5 s, 10 s, … — long enough for the window to
      // clear. Regular transient errors (5xx/overloaded): short jittered backoff.
      const isRateLimit = wrapped.code === 'RATE_LIMITED';
      const base = isRateLimit ? 5_000 * 2 ** (attempt - 1) : 250 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * (isRateLimit ? 1_000 : 100));
      await sleep(base + jitter);
    }
  }
  // Should be unreachable; the loop either returns or throws above.
  throw lastErr ?? new LlmClientError('Claude call failed without an error.', 'UPSTREAM_ERROR');
}

// Module-level memo for whether this account/endpoint honors structured
// outputs (`output_config`). Starts unknown; flips to false the first time the
// API rejects the param, so we don't keep paying a failed round-trip. null =
// untried, true = supported, false = unsupported (fall back to prompt + zod).
let structuredOutputSupported: boolean | null = null;

interface SingleAttemptArgs<T> {
  client: Anthropic;
  model: string;
  messages: Anthropic.MessageParam[];
  system?: Anthropic.TextBlockParam[];
  jsonSchema?: { schema: Record<string, unknown> };
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  validate: z.ZodType<T>;
}

async function singleAttempt<T>({
  client,
  model,
  messages,
  system,
  jsonSchema,
  temperature,
  maxOutputTokens,
  timeoutMs,
  validate,
}: SingleAttemptArgs<T>): Promise<T> {
  // AbortController so a timed-out call also tells the SDK to stop holding the
  // underlying fetch open. (Anthropic still bills tokens already generated.)
  const controller = new AbortController();

  const baseParams: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxOutputTokens,
    temperature,
    ...(system ? { system } : {}),
    messages,
  };

  // Layer 1 — structured outputs. The SDK version here doesn't type
  // `output_config`, but the request body is sent to the API as-is, so we
  // attach it via a widened type. `structuredOutputSupported === false` means a
  // prior call proved the endpoint rejects it; skip it then.
  const useStructured = !!jsonSchema && structuredOutputSupported !== false;
  const params: Anthropic.MessageCreateParamsNonStreaming =
    useStructured && jsonSchema
      ? ({
          ...baseParams,
          // Exact GA shape: output_config.format = { type, schema }. NOTE: no
          // `name` key — the API rejects any extra field here
          // ("output_config.format.name: Extra inputs are not permitted").
          output_config: {
            format: {
              type: 'json_schema',
              schema: jsonSchema.schema,
            },
          },
        } as Anthropic.MessageCreateParamsNonStreaming)
      : baseParams;

  let message: Anthropic.Message;
  try {
    message = await withTimeout(
      client.messages.create(params, { signal: controller.signal }),
      timeoutMs,
      controller
    );
    if (useStructured) structuredOutputSupported = true;
  } catch (err) {
    // If the provider rejected the structured-output parameter, remember that
    // and retry once this call without it (degrade to prompt + zod).
    if (useStructured && isUnsupportedParamError(err)) {
      structuredOutputSupported = false;
      console.warn(
        '[claude] output_config not supported by this endpoint; falling back to prompt + zod validation.'
      );
      const fallbackController = new AbortController();
      message = await withTimeout(
        client.messages.create(baseParams, { signal: fallbackController.signal }),
        timeoutMs,
        fallbackController
      );
    } else {
      throw err;
    }
  }

  logUsage(model, message.usage);

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text || text.trim().length === 0) {
    throw new LlmClientError('Claude returned an empty response.', 'EMPTY_RESPONSE');
  }

  let parsed: unknown;
  try {
    parsed = parseJsonLoose(text);
  } catch (err) {
    const reason = `the response was not valid JSON (${(err as Error).message})`;
    throw new LlmClientError(
      `Claude returned invalid JSON: ${(err as Error).message}. Raw: ${truncate(text, 200)}`,
      'INVALID_JSON',
      { responseText: truncate(text, 6_000), reason }
    );
  }

  const validated = validate.safeParse(parsed);
  if (!validated.success) {
    throw new LlmClientError(
      `Claude response failed schema validation: ${validated.error.message}`,
      'SCHEMA_MISMATCH',
      {
        responseText: truncate(text, 6_000),
        reason: `it failed schema validation: ${truncate(validated.error.message, 1_500)}`,
      }
    );
  }
  return validated.data;
}

/** Detect the specific "this endpoint doesn't know the `output_config` param at
 *  all" rejection, so we can fall back to prompt+zod. Deliberately NARROW:
 *
 *   - A deeper validation error on a sub-path (e.g. "output_config.format.name:
 *     Extra inputs are not permitted") means the endpoint DOES understand
 *     output_config and is validating into it — that's a bug in OUR request
 *     shape and must surface, not silently disable the feature.
 *   - Only when the top-level `output_config` field itself is reported as
 *     unknown / unexpected / unsupported do we treat the feature as absent. */
function isUnsupportedParamError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  if ((err.status ?? 0) !== 400) return false;
  const msg = err.message ?? '';
  // Sub-path error (something after "output_config.") → our shape is wrong.
  if (/output_config\.\w/i.test(msg)) return false;
  return (
    /output_config/i.test(msg) &&
    /(unexpected|unknown|unrecognized|not\s+permitted|not\s+supported|unsupported)/i.test(
      msg
    )
  );
}

// ----- helpers -----

/** Print a one-line per-request cost estimate to the server terminal so each
 *  parse / narration / match call's token spend is visible while developing. */
function logUsage(model: string, usage: Anthropic.Usage): void {
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const price = PRICE_PER_MTOK[model];
  let costStr = 'n/a';
  if (price) {
    // Uncached input at full rate; cache writes 1.25×, cache reads 0.1×.
    const billedIn = inTok + cacheWrite * 1.25 + cacheRead * 0.1;
    const cost = (billedIn / 1e6) * price.in + (outTok / 1e6) * price.out;
    costStr = `$${cost.toFixed(4)}`;
  }
  // Surface cache activity so prompt-caching wins are visible in the terminal:
  // cw = tokens written to cache (1.25× this call), cr = tokens read from cache
  // (0.1× — the savings). cr>0 on a repeat call means caching is working.
  const cacheStr =
    cacheWrite || cacheRead ? ` cache(w=${cacheWrite} r=${cacheRead})` : '';
  console.log(`[claude] ${model} in=${inTok} out=${outTok}${cacheStr} → ${costStr}`);
}

/** Parse JSON the model returned, tolerating stray prose or ```json fences
 *  the prompt asked it not to emit. */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = (fence ? fence[1] : trimmed).trim();
  try {
    return JSON.parse(body);
  } catch {
    // Fall back to slicing the outermost JSON object/array.
    const start = body.search(/[{[]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error('no JSON object found in response');
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller?: AbortController
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new LlmClientError(`Claude call timed out after ${ms} ms.`, 'TIMEOUT'));
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

/** Map an unknown thrown value into a typed LlmClientError. Uses the SDK's
 *  typed error classes where possible rather than string matching. */
function toLlmError(err: unknown): LlmClientError {
  if (err instanceof LlmClientError) return err;

  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (err instanceof Anthropic.RateLimitError || status === 429) {
      return new LlmClientError(`Claude rate limit: ${err.message}`, 'RATE_LIMITED');
    }
    if (err instanceof Anthropic.AuthenticationError || status === 401 || status === 403) {
      // No dedicated auth code; surface via UPSTREAM_ERROR with "API key" in
      // the message so callers' humanizers can detect it.
      return new LlmClientError(
        `Claude authentication failed — check ANTHROPIC_API_KEY (API key). ${err.message}`,
        'UPSTREAM_ERROR'
      );
    }
    if (status >= 500 || err instanceof Anthropic.InternalServerError) {
      return new LlmClientError(`Claude upstream error: ${err.message}`, 'UPSTREAM_ERROR');
    }
    return new LlmClientError(`Claude API error (${status}): ${err.message}`, 'UPSTREAM_ERROR');
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) {
    return new LlmClientError(`Claude call aborted: ${msg}`, 'TIMEOUT');
  }
  return new LlmClientError(`Claude call failed: ${msg}`, 'UPSTREAM_ERROR');
}

function isRetryable(err: LlmClientError): boolean {
  return (
    err.code === 'TIMEOUT' ||
    err.code === 'UPSTREAM_ERROR' ||
    err.code === 'EMPTY_RESPONSE' ||
    err.code === 'RATE_LIMITED'
  );
}
