// Layer 4 of the BenchGreen pipeline: turn a deterministic WeekPlanResult
// into prose for the UI.
//
//   engine planWeek()
//        │
//        ▼
//   WeekPlanResult              <- numbers, citations, schedule
//        │
//        ▼
//   narrateWeekPlan()           <- THIS MODULE
//        │
//        ▼
//   NarratedWeekPlanResult      <- engine fields + prose, byte-identical numbers
//
// Architecture (mirrors lib/llm/matchProtocol.ts):
//
//   1. Strip the input. The narrator only sees fields it needs to write
//      English. Citations, EPA URLs, task IDs, and schedule blocks are not
//      sent to Gemini — they pass around the LLM and stay attached to the
//      engine output.
//   2. Build a closed-vocabulary response schema parameterized by the input
//      array lengths (length-locked arrays kill "Gemini dropped a coord"
//      failure modes; position is the join key).
//   3. Try Gemini in JSON mode with that schema. 10 s timeout.
//   4. On any failure (no API key, timeout, schema mismatch, etc.) fall back
//      to deterministic English templates built from the engine's existing
//      `recommendation` / `rationale` / `reason` strings. Demo never breaks.
//
// The public function `narrateWeekPlan` always resolves; never throws.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateJson, llmAvailability, LlmClientError } from './client';
import {
  geminiResponseSchemaForNarrate,
  narrationResponseSchema,
  type LLMNarrationResponse,
} from './schemas';
import type {
  Coordination,
  CoordinationProse,
  NarratedCoordination,
  NarratedSeparation,
  NarratedWeekPlanResult,
  Separation,
  SeparationProse,
  WeekPlanResult,
} from '../engine/types';

const NARRATOR_MODEL = 'gemini-2.5-flash';
// Narration produces a long structured response (one prose object per
// coordination AND separation) so it consistently runs longer than the
// matcher's single-object call. 25 s is the demo's tolerance ceiling.
const NARRATOR_TIMEOUT_MS = 25_000;
const NARRATOR_TEMPERATURE = 0.4;

const HEADLINE_MAX = 90;
const BODY_MAX = 280;
const SAVINGS_PHRASE_MAX = 90;

// ----- Public API -----

export interface NarrateOptions {
  /** Skip Gemini entirely (used by tests and the offline demo path). */
  disable_llm?: boolean;
}

/** Always resolves. On any LLM failure, returns a fallback narration with
 *  `narration.generated = false` and a short `fallback_reason` string. */
export async function narrateWeekPlan(
  result: WeekPlanResult,
  opts: NarrateOptions = {}
): Promise<NarratedWeekPlanResult> {
  // 0. Edge case: no coordinations and no separations. Nothing for the LLM
  //    to write; emit a tagline and return early. Saves a Gemini round trip
  //    on the rare empty-week case.
  if (
    result.coordinations.length === 0 &&
    result.separations.length === 0
  ) {
    return wrapFallback(result, '', 'no items to narrate');
  }

  // 1. If LLM is disabled or unavailable, fall through to templates.
  if (opts.disable_llm) {
    return wrapFallback(result, '', 'LLM disabled by caller');
  }
  const avail = llmAvailability();
  if (!avail.available) {
    return wrapFallback(result, '', avail.reason);
  }

  // 2. Try Gemini.
  try {
    const response = await runLlmTier(result);
    return wrapGenerated(result, response);
  } catch (err) {
    const reason =
      err instanceof LlmClientError
        ? `LLM narration failed (${err.code}): ${err.message}`
        : `LLM narration threw: ${(err as Error).message}`;
    return wrapFallback(result, '', reason);
  }
}

// ----- LLM tier -----

let _promptTemplate: string | null = null;
function loadPromptTemplate(): string {
  if (_promptTemplate) return _promptTemplate;
  _promptTemplate = readFileSync(
    resolve(process.cwd(), 'lib/llm/prompts/narrate.md'),
    'utf8'
  );
  return _promptTemplate;
}

async function runLlmTier(result: WeekPlanResult): Promise<LLMNarrationResponse> {
  const stripped = stripForLlm(result);
  const prompt = loadPromptTemplate();
  const userBlock =
    `Plan to narrate:\n\n\`\`\`json\n${JSON.stringify(stripped, null, 2)}\n\`\`\``;

  return generateJson({
    prompt: `${prompt}\n\n---\n\n${userBlock}`,
    responseSchema: geminiResponseSchemaForNarrate(),
    validate: narrationResponseSchema(
      result.coordinations.length,
      result.separations.length
    ),
    model: NARRATOR_MODEL,
    timeoutMs: NARRATOR_TIMEOUT_MS,
    temperature: NARRATOR_TEMPERATURE,
  });
}

// ----- Strip input for the LLM -----
//
// Send only what's needed to write English. Hide:
//   - citations (EPA URLs, RCRA codes) — these flow around the LLM
//   - id strings — position is the join key
//   - schedule blocks — narrator doesn't reason about scheduling
//   - diagnostics — not user-facing prose
//
// Keep:
//   - participant names + task_ids (so the LLM can refer to people)
//   - recommendation + rationale (the deterministic phrasing as a starting point)
//   - savings (so the LLM can quote real numbers)
//   - aligned (so it can flag advisory cards)

interface StrippedCoordination {
  type: Coordination['type'];
  overlap_group?: string;
  equipment_group?: string;
  participants: { person: string; task_id: string; volume_ul?: number }[];
  recommendation: string;
  rationale: string[];
  savings: Coordination['savings'];
  aligned: boolean;
}

interface StrippedSeparation {
  pair: [string, string];
  severity: Separation['severity'];
  reason: string;
}

interface StrippedPlan {
  impact: WeekPlanResult['impact'];
  people_summary: string[];
  coordinations: StrippedCoordination[];
  separations: StrippedSeparation[];
}

function stripForLlm(result: WeekPlanResult): StrippedPlan {
  const peopleSet = new Set<string>();
  for (const c of result.coordinations) {
    for (const p of c.participants) peopleSet.add(p.person);
  }
  for (const t of result.schedule) peopleSet.add(t.person);

  return {
    impact: result.impact,
    people_summary: Array.from(peopleSet),
    coordinations: result.coordinations.map(
      (c): StrippedCoordination => ({
        type: c.type,
        overlap_group: c.overlap_group,
        equipment_group: c.equipment_group,
        participants: c.participants.map((p) => ({
          person: p.person,
          task_id: p.task_id,
          volume_ul: p.volume_ul,
        })),
        recommendation: c.recommendation,
        rationale: c.rationale,
        savings: c.savings,
        aligned: c.aligned,
      })
    ),
    separations: result.separations.map(
      (s): StrippedSeparation => ({
        pair: s.pair,
        severity: s.severity,
        reason: s.reason,
      })
    ),
  };
}

// ----- Wrappers (success + fallback) -----

function wrapGenerated(
  result: WeekPlanResult,
  llm: LLMNarrationResponse
): NarratedWeekPlanResult {
  const coordinations: NarratedCoordination[] = result.coordinations.map(
    (c, i) => ({
      ...c,
      prose: clampCoordinationProse(llm.coordinations[i]),
    })
  );
  const separations: NarratedSeparation[] = result.separations.map((s, i) => ({
    ...s,
    prose: clampSeparationProse(llm.separations[i]),
  }));

  return {
    week_start_iso: result.week_start_iso,
    schedule: result.schedule,
    impact: result.impact,
    diagnostics: result.diagnostics,
    coordinations,
    separations,
    headline_tagline: clampLine(llm.headline_tagline, 160),
    narration: {
      generated: true,
      model: NARRATOR_MODEL,
      fallback_reason: '',
    },
  };
}

function wrapFallback(
  result: WeekPlanResult,
  // For consistency we accept these even when empty so the call sites are
  // symmetric with wrapGenerated().
  _unused: '',
  fallbackReason: string
): NarratedWeekPlanResult {
  const coordinations: NarratedCoordination[] = result.coordinations.map(
    (c) => ({
      ...c,
      prose: deterministicCoordinationProse(c),
    })
  );
  const separations: NarratedSeparation[] = result.separations.map((s) => ({
    ...s,
    prose: deterministicSeparationProse(s),
  }));

  return {
    week_start_iso: result.week_start_iso,
    schedule: result.schedule,
    impact: result.impact,
    diagnostics: result.diagnostics,
    coordinations,
    separations,
    headline_tagline: deterministicHeadlineTagline(result),
    narration: {
      generated: false,
      model: null,
      fallback_reason: fallbackReason,
    },
  };
}

// ----- Deterministic templates (the fallback) -----
//
// These are the strings the UI shows when Gemini is down. They're not as
// fluent as LLM output but they're correct, on-brand, and never lie about
// numbers (every digit comes from the engine's savings struct).

function deterministicHeadlineTagline(result: WeekPlanResult): string {
  const w = result.impact.weekly;
  const parts: string[] = [];
  if (w.reagent_volume_saved_ml > 0) {
    parts.push(`${formatVolumeMl(w.reagent_volume_saved_ml)} of reagent saved`);
  }
  if (w.prep_events_saved > 0) {
    parts.push(
      `${w.prep_events_saved} prep ${plural(w.prep_events_saved, 'event')} consolidated`
    );
  }
  if (w.equipment_runs_saved > 0) {
    parts.push(
      `${w.equipment_runs_saved} equipment ${plural(w.equipment_runs_saved, 'run')} saved`
    );
  }
  if (w.hazardous_disposal_events_avoided > 0) {
    parts.push(
      `${w.hazardous_disposal_events_avoided} hazardous disposal ${plural(w.hazardous_disposal_events_avoided, 'event')} avoided`
    );
  }
  if (parts.length === 0) {
    // Fall back to a count-based tagline so we always say SOMETHING true even
    // when every quantified savings field rolled up to 0.
    if (
      result.coordinations.length > 0 ||
      result.separations.length > 0
    ) {
      const cBits: string[] = [];
      if (result.coordinations.length > 0) {
        const word =
          result.coordinations.length === 1 ? 'opportunity' : 'opportunities';
        cBits.push(
          `${result.coordinations.length} coordination ${word}`
        );
      }
      if (result.separations.length > 0) {
        cBits.push(
          `${result.separations.length} waste ${plural(result.separations.length, 'separation')} flagged`
        );
      }
      return `This week: ${joinAnd(cBits)}.`;
    }
    return 'No coordination opportunities found this week.';
  }
  return `This week: ${joinAnd(parts)}.`;
}

function deterministicCoordinationProse(c: Coordination): CoordinationProse {
  const peopleNames = uniq(c.participants.map((p) => p.person));
  const peopleClause =
    peopleNames.length === 0 ? '' : ` (${joinAnd(peopleNames)})`;

  const headline = clampLine(c.recommendation, HEADLINE_MAX);
  const rationaleLines = c.rationale.filter((r) => r.trim().length > 0);
  const body = clampLine(
    rationaleLines.length > 0
      ? `${rationaleLines.join(' ')}${peopleClause}`
      : `${c.participants.length} tasks would batch together${peopleClause}.`,
    BODY_MAX
  );
  const savings_phrase = clampLine(
    formatSavingsPhrase(c),
    SAVINGS_PHRASE_MAX
  );

  return { headline, body, savings_phrase };
}

function deterministicSeparationProse(s: Separation): SeparationProse {
  const [a, b] = s.pair;
  const severityPrefix =
    s.severity === 'critical'
      ? 'Critical: '
      : s.severity === 'warning'
        ? 'Warning: '
        : s.severity === 'check'
          ? 'Verify: '
          : '';
  const headline = clampLine(
    `${severityPrefix}${humanizeGroup(a)} must stay separate from ${humanizeGroup(b)}`,
    HEADLINE_MAX
  );
  const body = clampLine(
    s.reason ||
      `Keep ${humanizeGroup(a)} and ${humanizeGroup(b)} waste streams separated.`,
    BODY_MAX
  );
  return { headline, body };
}

function formatSavingsPhrase(c: Coordination): string {
  const s = c.savings;
  const bits: string[] = [];
  if (s.volume_ml && s.volume_ml > 0) {
    bits.push(`${formatVolumeMl(s.volume_ml)} of reagent`);
  }
  if (s.runs_saved && s.runs_saved > 0) {
    bits.push(`${s.runs_saved} ${plural(s.runs_saved, 'run')}`);
  }
  if (s.prep_events_saved && s.prep_events_saved > 0) {
    bits.push(
      `${s.prep_events_saved} prep ${plural(s.prep_events_saved, 'event')}`
    );
  }
  if (
    s.hazardous_disposal_events_avoided &&
    s.hazardous_disposal_events_avoided > 0
  ) {
    bits.push(
      `${s.hazardous_disposal_events_avoided} hazardous disposal ${plural(
        s.hazardous_disposal_events_avoided,
        'event'
      )}`
    );
  }
  let phrase: string;
  if (bits.length === 0) {
    // Schema requires a digit; satisfy it with 0 if the engine reported nothing.
    phrase = `Saves 0 quantified units (advisory recommendation).`;
  } else {
    phrase = `Saves ${joinAnd(bits)}`;
    if (s.co2e_kg_range && s.co2e_kg_range[1] >= 0.1) {
      const [lo, hi] = s.co2e_kg_range;
      phrase += `, ~${lo}–${hi} kg CO₂e`;
    }
  }
  if (!c.aligned) {
    phrase = `Advisory — scheduler couldn't align — ${phrase}`;
  }
  return phrase;
}

// ----- LLM-output sanitization -----
//
// Gemini in JSON mode honors the response schema, but we still defensively
// clamp lengths and trim whitespace before returning. Length overruns are
// caught by zod, but trimming and entity normalization isn't — that's done
// here so the UI can render the strings as-is.

function clampCoordinationProse(p: CoordinationProse): CoordinationProse {
  return {
    headline: clampLine(p.headline, HEADLINE_MAX),
    body: clampLine(p.body, BODY_MAX),
    savings_phrase: clampLine(p.savings_phrase, SAVINGS_PHRASE_MAX),
  };
}

function clampSeparationProse(p: SeparationProse): SeparationProse {
  return {
    headline: clampLine(p.headline, HEADLINE_MAX),
    body: clampLine(p.body, BODY_MAX),
  };
}

function clampLine(s: string, maxLen: number): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1).trimEnd()}…`;
}

// ----- text helpers -----

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

function joinAnd(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function formatVolumeMl(ml: number): string {
  if (ml < 1) return `${(ml * 1000).toFixed(0)} µL`;
  if (ml < 10) return `${ml.toFixed(1)} mL`;
  return `${Math.round(ml)} mL`;
}

function humanizeGroup(group: string): string {
  // Best-effort: replace underscores with spaces. Keeps the engine vocabulary
  // recognizable in the fallback path (UI's "show vendor terms" reveals the
  // raw codes anyway).
  return group.replace(/_/g, ' ');
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
