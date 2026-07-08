// Zod schemas for everything the LLM emits.
//
// Why zod here: Gemini returns JSON, but the SDK gives it to us as `unknown`.
// We need a hard parse step before any of it reaches the engine. A schema mismatch
// = a thrown error = the matcher falls back to its deterministic tiers.
//
// Schemas mirror the runtime types in /lib/engine/types.ts. When the engine types
// change, these must change with them — the duplication is intentional so the
// LLM contract is explicit and reviewable in one place.

import { z } from 'zod';

import { loadReagentTermMap } from '../engine/data';

// ----- Narrator (Layer 4) schemas -----
//
// The narrator returns one object per WeekPlanResult containing:
//   - headline_tagline: a single sentence for the top of the impact card
//   - coordinations[]: parallel-indexed array of prose, one per input coordination
//   - separations[]:   parallel-indexed array of prose, one per input separation
//
// "Parallel-indexed" = the i-th item in the response describes the i-th item
// in the request. Position is the join key, not name. This kills an entire
// class of "the LLM renamed coord_3 to coord_three" failure modes.

// Headlines are intentionally generous: the engine's deterministic
// recommendations (e.g. "Prep 23.2 mL of nuclease-free water (pcr_reaction_water)
// once; covers ary's platinum_ii_hot_start_green_pcr_master_mix_demo_96_well")
// already run past 90 chars and the card UI now wraps long words, so
// clamping to 90 was producing visible "…" tails. Bumped to 200 so even the
// fully expanded fallback survives without truncation while still keeping
// the LLM honest about not writing paragraphs in the headline slot.
const HEADLINE_MAX = 200;
const BODY_MAX = 280;

/** Light heuristic to keep the model from emitting hand-wavy savings phrases
 *  like "many" or "several". Real numbers come from coordination.savings.
 *
 *  We previously enforced this as a hard zod refine on every coord prose,
 *  but that failed atomically for the entire week's narration whenever the
 *  engine emitted at least one zero-savings coordination (e.g. an equipment
 *  share clamped to runs_saved=0 by capacity math). For those, the LLM has
 *  no number to quote and quite reasonably wrote things like "No runs saved".
 *  We now soft-check this in narrate.ts::wrapGenerated and substitute the
 *  deterministic phrase when the LLM forgets the digit. The schema only
 *  enforces presence + length so position-based joining stays safe. */
export const SAVINGS_PHRASE_DIGIT_REGEX = /\d/;

const coordinationProseSchema = z.object({
  headline: z.string().min(1).max(HEADLINE_MAX),
  body: z.string().min(1).max(BODY_MAX),
  savings_phrase: z.string().min(1).max(HEADLINE_MAX),
});

const separationProseSchema = z.object({
  headline: z.string().min(1).max(HEADLINE_MAX),
  body: z.string().min(1).max(BODY_MAX),
});

/** Build a top-level narration schema parameterized by the expected array
 *  lengths. Length-locking the arrays lets us fail fast if Gemini drops or
 *  duplicates an item — the join key is position, so wrong length = wrong
 *  output. */
export function narrationResponseSchema(
  coordinationCount: number,
  separationCount: number
) {
  return z.object({
    headline_tagline: z.string().min(1).max(160),
    coordinations: z
      .array(coordinationProseSchema)
      .length(coordinationCount),
    separations: z
      .array(separationProseSchema)
      .length(separationCount),
  });
}

export type LLMNarrationResponse = z.infer<
  ReturnType<typeof narrationResponseSchema>
>;

// ----- Parser (Layer 1.5) schemas -----
//
// The PDF parser is the universal-extraction path that replaces the old
// "match-then-hydrate" classifier flow. The LLM reads a vendor PDF and emits
// a `DraftProtocol`: reagents, equipment hints, thermal profile, and
// `missing_information` flags. The schema is shaped to make hallucination
// expensive: every reagent must pick its `proposed_overlap_group` from a
// closed enum derived at module-load time from `reagent_term_map.csv` (plus
// the literal `"new"` token), and any field the document doesn't quantify
// must come back null rather than as a guess.

/** Closed vocabulary of overlap groups the LLM is allowed to propose. Built
 *  from the seed term map at module load — exactly the same lever as
 *  `protocolNameEnum()` above. */
function overlapGroupOptions(): string[] {
  const groups = new Set<string>();
  for (const row of loadReagentTermMap()) {
    if (row.generic_overlap_group) groups.add(row.generic_overlap_group);
  }
  // `new` is the LLM's escape hatch for reagents that don't fit any known
  // bucket. The user confirms or overrides this in the review UI before the
  // engine sees the result.
  return [...groups, 'new'].sort();
}

function overlapGroupEnum() {
  const options = overlapGroupOptions();
  if (options.length === 0) {
    throw new Error(
      'reagent_term_map.csv has no overlap groups — cannot build parser schema.'
    );
  }
  return z.enum(options as unknown as readonly [string, ...string[]]);
}

const STAGE_VALUES = [
  'lysis',
  'bind',
  'wash',
  'elute',
  'setup',
  'other',
] as const;

const FAMILY_VALUES = [
  'DNA_extraction',
  'PCR',
  'Bead_cleanup',
  'Sequencing',
  'Other',
] as const;

// Lenient numeric: coerce strings ("95" → 95) and fall back to 0 for
// anything that can't be a finite number (undefined, null, an object — all of
// which the model has emitted for thermal-profile fields when it expressed the
// profile in a shape the rigid schema didn't anticipate). The downstream
// duration estimate (lib/engine/duration.ts) tolerates 0s, so a mis-shaped
// profile degrades to "setup time only" instead of hard-failing the whole
// parse. The prompt now documents the exact field names so well-behaved
// responses still carry the real numbers.
const lenientNumber = z.coerce.number().catch(0);

const thermalProfileObjectSchema = z.object({
  initial_denature_temp_c: lenientNumber,
  initial_denature_time_s: lenientNumber,
  cycle_denature_temp_c: lenientNumber,
  cycle_denature_time_s: lenientNumber,
  annealing_temp_c: lenientNumber,
  annealing_time_s: lenientNumber,
  extension_temp_c: lenientNumber,
  extension_time_s: lenientNumber,
  cycles: lenientNumber,
  final_extension_temp_c: lenientNumber,
  final_extension_time_s: lenientNumber,
  notes: z.string().catch(''),
});

// Layer 2 — reshaping/canonicalization. Structured outputs (when the API
// honors it) already forces the flat shape, but in the fallback path (or on a
// provider that ignores the schema) the model expresses PCR profiles in varied
// ways. This deterministic pre-pass folds the two shapes we've actually seen —
// `cycles` as an object, and a per-phase `steps`/`phases` array — into the flat
// shape the engine consumes, *before* zod coercion. It never throws and only
// fills fields it can confidently derive; anything left over defaults to 0 via
// `lenientNumber`. Extending to a richer profile model is tracked in
// ChangesToBeMadeForPilot.md.
function canonicalizeThermalProfile(input: unknown): unknown {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const src = { ...(input as Record<string, unknown>) };

  // 1) `cycles` arrived as an object (observed failure mode): pull the count.
  if (src.cycles && typeof src.cycles === 'object' && !Array.isArray(src.cycles)) {
    const c = src.cycles as Record<string, unknown>;
    const count = firstNumber(c.count, c.cycles, c.number, c.n, c.value, c.repeats);
    src.cycles = count ?? 0;
  }

  // 2) A per-phase array (`steps` / `phases` / `stages`) instead of flat fields:
  //    map each phase to the flat slots by its label + temperature.
  const phases = firstArray(src.steps, src.phases, src.stages, src.cycling, src.program);
  if (phases) {
    for (const raw of phases) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const label = String(
        p.name ?? p.step ?? p.stage ?? p.phase ?? p.label ?? ''
      ).toLowerCase();
      const temp = firstNumber(p.temp_c, p.temperature_c, p.temperature, p.temp);
      const time = firstNumber(
        p.time_s, p.duration_s, p.seconds, p.time, p.duration, p.hold_s
      );
      const reps = firstNumber(p.cycles, p.repeats, p.count);

      const isInitial = /initial|hot[\s-]?start|pre[\s-]?denat/.test(label);
      const isFinal = /final/.test(label);
      if (/denat/.test(label)) {
        assignIfMissing(src, isInitial ? 'initial_denature_temp_c' : 'cycle_denature_temp_c', temp);
        assignIfMissing(src, isInitial ? 'initial_denature_time_s' : 'cycle_denature_time_s', time);
      } else if (/anneal/.test(label)) {
        assignIfMissing(src, 'annealing_temp_c', temp);
        assignIfMissing(src, 'annealing_time_s', time);
      } else if (/extens|elongat/.test(label)) {
        assignIfMissing(src, isFinal ? 'final_extension_temp_c' : 'extension_temp_c', temp);
        assignIfMissing(src, isFinal ? 'final_extension_time_s' : 'extension_time_s', time);
      }
      if (reps != null && src.cycles == null) src.cycles = reps;
    }
  }
  return src;
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

function firstArray(...vals: unknown[]): unknown[] | null {
  for (const v of vals) if (Array.isArray(v)) return v;
  return null;
}

function assignIfMissing(
  obj: Record<string, unknown>,
  key: string,
  value: number | null
): void {
  if (value != null && obj[key] == null) obj[key] = value;
}

const thermalProfileSchema = z
  .preprocess(canonicalizeThermalProfile, thermalProfileObjectSchema)
  .nullable()
  // If the model emits a thermal profile in a wholly unexpected top-level
  // shape that even canonicalization can't fold, treat it as "no profile"
  // rather than failing the whole parse.
  .catch(null);

/** Lazily memoized so importing the module doesn't read the CSV until needed. */
let _parseSchema: ReturnType<typeof buildParseSchema> | null = null;

function buildParseSchema() {
  const OverlapGroup = overlapGroupEnum();
  const Stage = z.enum(STAGE_VALUES);
  const Family = z.enum(FAMILY_VALUES);

  const draftReagent = z.object({
    raw_term: z.string().min(1).max(200),
    volume_per_sample_ul: z.coerce.number().nonnegative().nullable().catch(null),
    dead_volume_pct: z.coerce.number().nonnegative().nullable().catch(null),
    // The stage enum is a DNA-extraction vocabulary; a PCR (or other) reagent
    // has no good fit and the model legitimately emits values outside it.
    // `proposed_stage` is only a free-text hint downstream (type is `string`),
    // so an unrecognized stage falls back to "other" rather than failing the
    // entire parse over a non-load-bearing label.
    proposed_stage: Stage.catch('other'),
    proposed_overlap_group: OverlapGroup,
    cas_number: z.string().nullable().catch(null),
    shareable_prep: z.boolean().catch(false),
  });

  const draftEquipmentHint = z.object({
    equipment_type: z.string().min(1).max(120),
    // The model returns null when only a generic equipment type is mentioned
    // (the JSON schema allows ["string","null"]); .catch('') absorbs null and
    // anything non-string into "". (Schema-required string here was one of the
    // original SCHEMA_MISMATCH causes.)
    model_hint: z.string().max(200).catch(''),
  });

  const draftMissing = z.object({
    field: z.string().min(1).max(200),
    why: z.string().min(1).max(500),
  });

  // Tiered strictness (Layer 3): fields the engine can't function without stay
  // strict; cosmetic / user-overridable fields fall back to a safe default so a
  // single odd value never discards an otherwise-good parse.
  //   STRICT  — reagents (>=1), each reagent's raw_term + proposed_overlap_group.
  //             A protocol with no reagents, an unnamed reagent, or an invalid
  //             overlap group is a real failure worth surfacing.
  //   LENIENT — everything below: protocol_name (falls back to filename in
  //             normalizeDraft), vendor/primary_technique (display only),
  //             family (defaults to the conservative "Other", which gates the
  //             LEAST cross-protocol overlap), and sample counts (the user
  //             confirms the real count in the UI; these are just defaults).
  return z.object({
    protocol_name: z.string().max(300).catch(''),
    vendor: z.string().max(200).catch(''),
    family: Family.catch('Other'),
    primary_technique: z.string().max(120).catch(''),
    samples_default: z.coerce.number().int().positive().catch(8),
    samples_max: z.coerce.number().int().positive().catch(8),
    reagents: z.array(draftReagent).min(1).max(60),
    equipment_required: z.array(draftEquipmentHint).max(20),
    thermal_profile: thermalProfileSchema,
    missing_information: z.array(draftMissing).max(40),
  });
}

export function parseProtocolResponseSchema() {
  if (!_parseSchema) _parseSchema = buildParseSchema();
  return _parseSchema;
}

/** Plain JSON Schema (draft 2020-12 subset) for Anthropic **structured
 *  outputs** (`output_config.format`). This is the constrained-decoding
 *  contract: the model is grammar-restricted to this shape at generation time,
 *  so "wrong field name / wrong nesting / out-of-enum value" failures become
 *  structurally impossible rather than caught after the fact.
 *
 *  Unlike the old Gemini OpenAPI-flavored schemas (since removed), Anthropic
 *  structured outputs require
 *    - `additionalProperties: false` on EVERY object, and
 *    - every property listed in `required`,
 *  and use JSON-Schema null unions (`type: ["string", "null"]`) instead of
 *  OpenAPI's `nullable: true`.
 *
 *  Gotcha (see Anthropic docs): numeric bounds like `minimum`/`maxLength` are
 *  NOT enforced by the decoder — they're stripped into descriptions and only
 *  re-checked by the SDK afterward. So we do NOT rely on them here; the closed
 *  ENUMS (family, stage, overlap group) are the load-bearing constraints, and
 *  zod re-validates everything after parsing as the authoritative check. */
export function parseProtocolJsonSchema(): Record<string, unknown> {
  const groups = overlapGroupOptions();

  const reagent = {
    type: 'object',
    additionalProperties: false,
    properties: {
      raw_term: {
        type: 'string',
        description: 'Reagent name exactly as written in the PDF, e.g. "Buffer AL".',
      },
      volume_per_sample_ul: {
        type: ['number', 'null'],
        description:
          'Per-sample volume in microliters. null when the document does not quantify it — never guess; add a missing_information entry instead.',
      },
      dead_volume_pct: {
        type: ['number', 'null'],
        description: 'Pipetting/dead-volume overhead percent (0-100). null when you have no basis.',
      },
      proposed_stage: {
        type: 'string',
        enum: [...STAGE_VALUES],
        description: 'Workflow stage. Use "other" when none of the rest fit.',
      },
      proposed_overlap_group: {
        type: 'string',
        enum: groups,
        description:
          'Closest matching generic_overlap_group from the closed list, or the literal "new". NEVER invent a group.',
      },
      cas_number: {
        type: ['string', 'null'],
        description: 'CAS Registry Number when explicitly stated; null otherwise.',
      },
      shareable_prep: {
        type: 'boolean',
        description: 'True when this could be prepped once and split across identical tasks.',
      },
    },
    required: [
      'raw_term',
      'volume_per_sample_ul',
      'dead_volume_pct',
      'proposed_stage',
      'proposed_overlap_group',
      'cas_number',
      'shareable_prep',
    ],
  };

  const equipment = {
    type: 'object',
    additionalProperties: false,
    properties: {
      equipment_type: {
        type: 'string',
        description:
          'Functional type: thermocycler, magnetic_separator, centrifuge, liquid_handler, sequencer, plate_sealer, thermomixer, vortex, support_device.',
      },
      model_hint: {
        type: ['string', 'null'],
        description: 'Free-text model from the PDF, e.g. "Bio-Rad C1000". null/"" when only a generic type is named.',
      },
    },
    required: ['equipment_type', 'model_hint'],
  };

  const thermalNumber = { type: 'number' as const };
  const thermalProfile = {
    type: ['object', 'null'],
    additionalProperties: false,
    description: 'PCR thermal profile, flat shape. null for non-PCR protocols.',
    properties: {
      initial_denature_temp_c: thermalNumber,
      initial_denature_time_s: thermalNumber,
      cycle_denature_temp_c: thermalNumber,
      cycle_denature_time_s: thermalNumber,
      annealing_temp_c: thermalNumber,
      annealing_time_s: thermalNumber,
      extension_temp_c: thermalNumber,
      extension_time_s: thermalNumber,
      cycles: { type: 'number', description: 'Plain integer cycle count — never an object or array.' },
      final_extension_temp_c: thermalNumber,
      final_extension_time_s: thermalNumber,
      // notes is a free-text caveat caption (touchdown, 2-step PCR, …) and is
      // NOT read by the engine — thermalKey()/duration.ts use only the numeric
      // fields. It's semantically optional, so allow null: a plain 3-step PCR
      // with no caveats has nothing to write. Kept in `required` because
      // Anthropic structured outputs require every property to be listed, but
      // the null union lets the grammar emit "no notes" cleanly. zod's
      // `notes: z.string().catch('')` then normalizes null → '' authoritatively.
      // (Mirrors the lenient zod contract — keep the two in sync per AGENTS.md.)
      notes: { type: ['string', 'null'] },
    },
    required: [
      'initial_denature_temp_c',
      'initial_denature_time_s',
      'cycle_denature_temp_c',
      'cycle_denature_time_s',
      'annealing_temp_c',
      'annealing_time_s',
      'extension_temp_c',
      'extension_time_s',
      'cycles',
      'final_extension_temp_c',
      'final_extension_time_s',
      'notes',
    ],
  };

  const missing = {
    type: 'object',
    additionalProperties: false,
    properties: {
      field: { type: 'string', description: 'Short identifier of the missing field.' },
      why: { type: 'string', description: 'One sentence on what the value would have been used for.' },
    },
    required: ['field', 'why'],
  };

  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      protocol_name: { type: 'string' },
      vendor: { type: 'string' },
      family: { type: 'string', enum: [...FAMILY_VALUES] },
      primary_technique: { type: 'string' },
      samples_default: { type: 'integer' },
      samples_max: { type: 'integer' },
      reagents: { type: 'array', items: reagent },
      equipment_required: { type: 'array', items: equipment },
      thermal_profile: thermalProfile,
      missing_information: { type: 'array', items: missing },
    },
    required: [
      'protocol_name',
      'vendor',
      'family',
      'primary_technique',
      'samples_default',
      'samples_max',
      'reagents',
      'equipment_required',
      'thermal_profile',
      'missing_information',
    ],
  };
}

/** The list of allowed overlap groups, exposed so the prompt template can
 *  inline them at request build time. */
export function allowedOverlapGroupValues(): string[] {
  return overlapGroupOptions();
}

/** Reset memoized schema. Useful for tests when the seed CSV changes. */
export function __resetSchemaCache(): void {
  _parseSchema = null;
}
