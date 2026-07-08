// Universal PDF protocol extractor.
//
// Replaces the demo-era "classify the upload as one of 9 catalog protocols
// then look up everything in seed CSVs" flow. This module takes any
// molecular-biology protocol PDF and asks Claude (Sonnet 4.6) to extract a
// structured DraftProtocol — reagents, equipment hints, thermal profile,
// missing_information flags.
//
// The output is intentionally NOT an EnrichedProtocol. The shape preserves
// the LLM's uncertainty (null volumes, "new" overlap groups, free-text
// equipment hints) so the UI confirmation step can show the user exactly
// what was extracted before any of it reaches the deterministic engine.
//
// Architecture is parallel to /lib/llm/matchProtocol.ts (timeouts, retries,
// schema validation, error humanization) but for the much bigger extraction
// payload.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DraftProtocol } from '../engine/types';
import { DEFAULT_MODEL, generateJson, LlmClientError, llmAvailability } from './client';
import {
  allowedOverlapGroupValues,
  parseProtocolJsonSchema,
  parseProtocolResponseSchema,
} from './schemas';

// Claude Sonnet 4.6 (ChangesToBeMadeForPilot.md §8): strong on dense numerical
// tables (volumes, thermal-cycle counts), accepts PDFs natively as `document`
// blocks. The user-confirmation step still gates every reagent + volume before
// the engine runs, so extraction errors are caught by a human, not silently
// scheduled.
const PARSER_MODEL = 'claude-sonnet-4-6';

// A multi-page handbook can take 15-30s. 45s is comfortable headroom for the
// slowest documents we expect (full vendor manuals) without holding the UI
// hostage on a flaky upstream.
const PARSER_TIMEOUT_MS = 45_000;

// 3 attempts: the extra attempt is specifically for rate-limit recovery.
// Rate-limit retries use a 5 s / 10 s backoff (see client.ts) so wall time
// only grows meaningfully when Gemini is actually throttling us.
const PARSER_MAX_ATTEMPTS = 3;

// Hold-the-line size cap. 30 MB covers every realistic vendor handbook
// while keeping a misbehaving upload from blowing up Node memory.
const MAX_PDF_BYTES = 30 * 1024 * 1024;

export interface ParseInput {
  /** Original uploaded filename, used to fill protocol_name when the PDF
   *  itself has no clearer title. */
  filename: string;
  /** Raw PDF bytes. */
  file_bytes: Buffer;
  /** MIME type if known. Defaults to application/pdf. */
  mime_type?: string;
  /** Plain-text extract for cases where the PDF couldn't be rendered
   *  (encrypted / image-only / corrupted). When set we pass text-only and
   *  skip the binary attachment. */
  text_fallback?: string;
}

export interface ParseSuccess {
  ok: true;
  draft: DraftProtocol;
  /** Model id we actually used, for provenance / debugging. */
  model: string;
  /** Total wall time including retries, ms. */
  elapsed_ms: number;
}

export interface ParseFailure {
  ok: false;
  /** Short, UI-safe error reason. */
  message: string;
  /** Machine-readable category for the API layer to translate to HTTP. */
  code:
    | 'NO_API_KEY'
    | 'TIMEOUT'
    | 'INVALID_JSON'
    | 'SCHEMA_MISMATCH'
    | 'UPSTREAM_ERROR'
    | 'EMPTY_RESPONSE'
    | 'RATE_LIMITED'
    | 'INPUT_TOO_LARGE'
    | 'BAD_INPUT';
  /** Raw underlying error message, for debugging. Never shown to users. */
  raw?: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** Parse a protocol PDF into a structured DraftProtocol. Always resolves —
 *  never throws — so the API layer doesn't need a try/catch wrapper. */
export async function parseProtocolFromPdf(
  input: ParseInput
): Promise<ParseResult> {
  const start = Date.now();

  if (!input.file_bytes && !input.text_fallback) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      message: 'No PDF bytes or text fallback supplied.',
    };
  }
  if (input.file_bytes && input.file_bytes.length > MAX_PDF_BYTES) {
    return {
      ok: false,
      code: 'INPUT_TOO_LARGE',
      message: `PDF exceeds ${(MAX_PDF_BYTES / 1024 / 1024).toFixed(0)} MB; please trim or compress.`,
    };
  }
  const availability = llmAvailability();
  if (!availability.available) {
    return {
      ok: false,
      code: 'NO_API_KEY',
      message:
        'ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.',
    };
  }

  // The bulky, request-invariant instructions (template + overlap-group
  // vocabulary) go in a cached `system` block; only the small per-upload part
  // (filename + optional text excerpt) is dynamic. See client.ts for how the
  // cache breakpoints are placed.
  const system = buildSystemPrompt();

  const attachments =
    !input.text_fallback && input.file_bytes
      ? [
          {
            mimeType: input.mime_type ?? 'application/pdf',
            data: input.file_bytes,
          },
        ]
      : undefined;

  const userPrompt = input.text_fallback
    ? `Filename: ${input.filename}\n\n---\n\nDocument text excerpt:\n"""\n${input.text_fallback.slice(0, 60_000)}\n"""`
    : `Filename: ${input.filename}`;

  // The prompt instructs "return JSON only" and we validate with zod after
  // parsing — same correctness guarantee whether the document arrived as a
  // PDF `document` block or as a text excerpt.
  try {
    const draft = (await generateJson({
      system,
      prompt: userPrompt,
      attachments,
      // Cache the full prefix (system + document) so two labmates uploading the
      // same handbook within the window don't pay twice.
      cacheUserPrefix: true,
      // Layer 1: constrain generation to the draft shape (grammar-enforced
      // where the API supports it; zod is still the authoritative check).
      jsonSchema: { schema: parseProtocolJsonSchema() },
      // Layer 4: on a rare residual validation miss, re-prompt once with the
      // error instead of failing the upload.
      repairOnInvalid: true,
      validate: parseProtocolResponseSchema() as never,
      model: PARSER_MODEL,
      timeoutMs: PARSER_TIMEOUT_MS,
      temperature: 0,
      maxAttempts: PARSER_MAX_ATTEMPTS,
    })) as DraftProtocol;

    return {
      ok: true,
      draft: normalizeDraft(draft, input.filename),
      model: PARSER_MODEL,
      elapsed_ms: Date.now() - start,
    };
  } catch (err) {
    return wrapFailure(err);
  }
}

// ----- helpers -----

let _promptTemplate: string | null = null;
function loadPromptTemplate(): string {
  if (_promptTemplate) return _promptTemplate;
  _promptTemplate = readFileSync(
    resolve(process.cwd(), 'lib/llm/prompts/parseProtocol.md'),
    'utf8'
  );
  return _promptTemplate;
}

/** The static instruction prompt (template + closed overlap-group vocabulary).
 *  Identical on every parse call, so it's sent as a cached `system` block. */
function buildSystemPrompt(): string {
  const tmpl = loadPromptTemplate();
  const groupList = allowedOverlapGroupValues()
    .map((g) => `  - ${g}`)
    .join('\n');
  return tmpl.replace('{{OVERLAP_GROUP_LIST}}', `\n${groupList}\n`);
}

/** Backstop normalization for fields the LLM tends to leave underspecified.
 *  Keeps the downstream resolver simpler by making sure every required field
 *  has a sensible value before any further code touches the draft. */
function normalizeDraft(raw: DraftProtocol, filename: string): DraftProtocol {
  const protocol_name = raw.protocol_name?.trim() || filename;

  const reagents = raw.reagents.map((r) => ({
    ...r,
    raw_term: r.raw_term.trim(),
    cas_number: r.cas_number ? r.cas_number.trim() : null,
  }));

  const equipment_required = raw.equipment_required.map((e) => ({
    equipment_type: e.equipment_type.trim().toLowerCase(),
    // model_hint is guaranteed a string by the schema (.catch('') absorbs the
    // null the model emits for generic equipment).
    model_hint: e.model_hint.trim(),
  }));

  const missing_information = raw.missing_information ?? [];

  return {
    ...raw,
    protocol_name,
    vendor: raw.vendor?.trim() ?? '',
    reagents,
    equipment_required,
    missing_information,
  };
}

function wrapFailure(err: unknown): ParseFailure {
  const raw = err instanceof Error ? err.message : String(err);

  if (err instanceof LlmClientError) {
    console.error(`[parseProtocol] ${err.code}: ${raw}`);
    const friendly = humanize(err.code, raw);
    return {
      ok: false,
      code: mapClientCode(err.code),
      message: friendly,
      raw,
    };
  }

  return {
    ok: false,
    code: 'UPSTREAM_ERROR',
    message: 'Could not reach the protocol parser. Please try again.',
    raw,
  };
}

function mapClientCode(c: LlmClientError['code']): ParseFailure['code'] {
  switch (c) {
    case 'NO_API_KEY':
      return 'NO_API_KEY';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'INVALID_JSON':
      return 'INVALID_JSON';
    case 'SCHEMA_MISMATCH':
      return 'SCHEMA_MISMATCH';
    case 'EMPTY_RESPONSE':
      return 'EMPTY_RESPONSE';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'UPSTREAM_ERROR':
    default:
      return 'UPSTREAM_ERROR';
  }
}

function humanize(code: LlmClientError['code'], raw: string): string {
  switch (code) {
    case 'NO_API_KEY':
      return 'ANTHROPIC_API_KEY is missing. Add it to .env.local and restart the dev server.';
    case 'TIMEOUT':
      return 'The parser took too long. Try a smaller PDF or split the document.';
    case 'INVALID_JSON':
      return 'The parser returned malformed JSON. Try uploading again; this is usually transient.';
    case 'SCHEMA_MISMATCH':
      return 'The parser returned unexpected fields. Try again, or upload a different version of the protocol.';
    case 'EMPTY_RESPONSE':
      return 'The parser returned nothing. Try again; this is usually transient.';
    case 'RATE_LIMITED':
      return 'Claude rate limit hit. The parser retried automatically but the limit persisted — please wait a moment and try again.';
    case 'UPSTREAM_ERROR':
    default:
      if (/\b401\b|\b403\b|API key|permission|authentication/i.test(raw)) {
        return 'The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in .env.local and restart.';
      }
      if (/\b404\b|not\s+found|model/i.test(raw)) {
        return 'Claude model not available for this API key. Check the model identifier or your account access.';
      }
      if (/invalid.*pdf|could not process|unsupported.*document/i.test(raw)) {
        return "Couldn't read the uploaded PDF (looks scanned, encrypted, or not a standard PDF).";
      }
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
        return 'Could not reach Claude right now (network).';
      }
      return 'The protocol parser failed. Please try again.';
  }
}

/** Re-export so tests / callers can pick the default model without crossing modules. */
export const DEFAULT_PARSER_MODEL = PARSER_MODEL;
export const FALLBACK_MODEL = DEFAULT_MODEL;
