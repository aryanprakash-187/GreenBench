// Types for the engine's data layer.
//
// Layered design (matches the LLM-layer architecture in /docs):
//   Layer 1: ProtocolMatchResult   <- what the LLM/keyword matcher emits
//   Layer 2: EnrichedProtocol      <- pure-code join of seed CSVs + EPA cache + equipment
//   Layer 3: WeekPlanResult        <- engine output (deterministic; defined in scheduler.ts later)
//   Layer 4: NarratedWeekPlanResult<- LLM narrator output (deferred, separate pass)
//
// EnrichedProtocol is the contract the (future) deterministic engine consumes.
// It is intentionally self-contained: every reagent already carries its EPA hazard
// summary, every equipment entry is already bound to a concrete lab catalog row.
// That means the engine never has to call EPA, never has to re-read a CSV, and
// the LLM never sees safety-relevant fields.

// ----- Source CSV row types (mirror the headers in /data/seed/*.csv) -----

export interface ProtocolSelectedRow {
  family: string;
  vendor: string;
  protocol_name: string;
  primary_technique: string;
  why_selected: string;
  key_overlap_points: string;
}

export interface ReagentTermMapRow {
  raw_term: string;
  normalized_name: string;
  generic_overlap_group: string;
  workflow_family: string;
  stage: string;
  shareable_prep: string;
  hazard_or_handling_flag: string;
  epa_lookup_key: string;
  protocol_examples: string;
}

export interface ProtocolReagentRow {
  protocol_name: string;
  reagent_raw_term: string;
  volume_per_sample_ul: string;
  dead_volume_pct: string;
  per_sample: string;
  samples_default: string;
  samples_max: string;
}

export interface ProtocolThermalProfileRow {
  protocol_name: string;
  initial_denature_temp_c: string;
  initial_denature_time_s: string;
  cycle_denature_temp_c: string;
  cycle_denature_time_s: string;
  annealing_temp_c: string;
  annealing_time_s: string;
  extension_temp_c: string;
  extension_time_s: string;
  cycles: string;
  final_extension_temp_c: string;
  final_extension_time_s: string;
  notes: string;
}

export interface ReagentStabilityRow {
  generic_overlap_group: string;
  stable_hours_after_prep: string;
  storage_requirement: string;
  notes: string;
}

export interface OverlapRuleRow {
  generic_overlap_group: string;
  can_batch_prep: string;
  prep_overhead_ml: string;
  max_batch_ml: string;
  notes: string;
}

export interface EquipmentRow {
  id: string;
  type: string;
  model: string;
  capacity: string;
  block_type: string;
  settings_configurable: string;
  notes: string;
}

export interface EquipmentTermMapRow {
  raw_term: string;
  normalized_name: string;
  equipment_group: string;
  batchable_yes_no: string;
  core_MVP_yes_no: string;
  notes: string;
}

// ----- Enriched (Layer 2) types — what the engine consumes -----

/** EPA-derived hazard summary for one reagent, drawn from /data/epa_cache.json. */
export interface ReagentHazardSummary {
  epa_lookup_key: string;
  /** EPA classification text, free-form. Always present (may say "by analogy"). */
  epa_classification: string;
  /** RCRA waste code (e.g. "D001") if EPA tracks one for this category, else null. */
  rcra_code: string | null;
  /** Other epa_lookup_key buckets this one is incompatible with (for waste rules). */
  incompatibilities: string[];
  comptox_hazard_flags: string[];
  /** True when EPA has no entry for the underlying chemistry and the bucket is a
   *  best-effort screening category. UI should show a "screening category" badge. */
  classification_by_analogy: boolean;
  /** Citation URLs the UI renders inline next to recommendations / warnings. */
  sources: string[];
}

/** A single reagent inside a hydrated protocol, with everything the engine needs. */
export interface EnrichedReagent {
  raw_term: string;
  normalized_name: string;
  /** The cross-vendor functional class. This is the key the engine uses to find
   *  shareable reagents across different-vendor protocols. */
  generic_overlap_group: string;
  stage: string;
  shareable_prep: boolean;
  hazard_or_handling_flag: string;
  /** Per-sample volume from protocol_reagents.csv, in microliters. 0 means "not
   *  quantified by the vendor manual" (e.g. mineral oil overlay). */
  volume_per_sample_ul: number;
  dead_volume_pct: number;
  /** volume_per_sample_ul * sample_count, rounded to 0.1 µL. */
  volume_total_ul: number;
  /** Stability join from reagent_stability.csv, null for reagents we don't track. */
  stability: {
    stable_hours_after_prep: number;
    storage_requirement: string;
  } | null;
  /** Batch-prep eligibility join from overlap_rules.csv, null if not batchable. */
  batch_prep: {
    prep_overhead_ml: number;
    max_batch_ml: number;
    notes: string;
  } | null;
  /** EPA hazard summary; null only when the reagent's epa_lookup_key has no cache entry
   *  (which would be a data-team bug — the engine should warn, not crash). */
  hazard: ReagentHazardSummary | null;
  /** Per-liter footprint range from impact_coefficients.json, null if no estimate. */
  impact_per_liter: {
    co2e_kg: { low: number; mid: number; high: number };
    hazardous_disposal_cost_usd?: { low: number; mid: number; high: number };
    source_type: string;
  } | null;
}

/** PCR-only thermal profile. The engine compares these for batchability — two PCR
 *  tasks can share a thermocycler block iff their thermal profiles are equal. */
export interface ThermalProfile {
  initial_denature_temp_c: number;
  initial_denature_time_s: number;
  cycle_denature_temp_c: number;
  cycle_denature_time_s: number;
  annealing_temp_c: number;
  annealing_time_s: number;
  extension_temp_c: number;
  extension_time_s: number;
  cycles: number;
  final_extension_temp_c: number;
  final_extension_time_s: number;
  notes: string;
}

/** A piece of lab equipment this protocol needs, already bound to a concrete catalog row. */
export interface EquipmentRequirement {
  /** The functional group, e.g. "thermocycler", "centrifuge", "magnet_plate_96". */
  equipment_group: string;
  /** The chosen lab catalog row id, e.g. "thermo-c1000-a". May be null if no
   *  equipment in /data/seed/equipment.csv satisfies this group — the engine
   *  should surface this as a missing-equipment warning. */
  lab_id: string | null;
  /** Capacity of the chosen equipment (samples / wells / tubes per run). */
  capacity: number | null;
  batchable: boolean;
  notes: string;
}

/** Per-protocol "missing information" the user (or LLM) should resolve before scheduling. */
export interface MissingInformation {
  field: string;
  /** Human-readable explanation for the UI. */
  why_needed: string;
  /** If we have a sensible default, what we substituted; null when no default fired. */
  substituted_value: string | null;
}

/** The fully hydrated protocol. This is the unit the engine schedules. */
export interface EnrichedProtocol {
  protocol_name: string;
  family: string;
  vendor: string;
  primary_technique: string;
  sample_count: number;
  /** Multiplier basis: matches what each volume was multiplied by. Mirrors sample_count
   *  but is preserved separately so the engine can show "12 samples × 25 µL" in the UI. */
  sample_count_basis: number;
  reagents: EnrichedReagent[];
  equipment_required: EquipmentRequirement[];
  /** PCR protocols only. null for extraction and bead cleanup. */
  thermal_profile: ThermalProfile | null;
  /** Things the seed data couldn't supply (rare today since the CSVs are curated). */
  missing_information: MissingInformation[];
  /** Provenance for the demo's "show your work" expandables. */
  provenance: {
    matched_via: 'filename' | 'keyword' | 'llm' | 'manual';
    seed_data_version: string;
  };
}

// ----- Engine I/O (Layer 3) -----
//
// The deterministic engine consumes a list of EnrichedProtocols (one per
// person × task) plus per-person busy calendars and emits a WeekPlanResult.
// Pure code: no LLM, no fs, no network.

/** A single contiguous busy block on a person's calendar. ISO timestamps
 *  (UTC, with offset preserved when present in the source ICS). */
export interface BusyInterval {
  start_iso: string;
  end_iso: string;
  summary: string;
}

/** One hydrated task that the engine should schedule. */
export interface HydratedTask {
  /** Stable id synthesized by the API layer ("sohini__dneasy__1"). */
  task_id: string;
  protocol: EnrichedProtocol;
}

/** Per-person input to the engine. */
export interface EnginePerson {
  name: string;
  /** Optional join to operators.csv for availability windows; if absent the
   *  engine treats the person as available across the entire workday window. */
  operator_id?: string;
  /** Pre-parsed busy intervals (engine consumer parses ICS upstream). */
  busy: BusyInterval[];
  tasks: HydratedTask[];
}

/** Top-level engine input. */
export interface EnginePlanInput {
  /** Monday 00:00 of the planning week, ISO 8601. The engine schedules within
   *  [week_start_iso, week_start_iso + 7 days). */
  week_start_iso: string;
  people: EnginePerson[];
}

/** A scheduled task in the final week plan. */
export interface ScheduledTask {
  task_id: string;
  person: string;
  protocol_name: string;
  family: string;
  start_iso: string;
  end_iso: string;
  duration_min: number;
  /** Equipment slots reserved for this task. */
  equipment: { equipment_group: string; lab_id: string | null }[];
  /** Other task_ids batched together on shared equipment / shared prep. */
  shared_with: string[];
  notes: string[];
}

/** A coordination opportunity the engine identified.
 *  recommendation is a short placeholder string; the LLM narrator will
 *  replace it with prose in a later pass. */
export interface CoordinationParticipant {
  person: string;
  task_id: string;
  /** For shared_reagent_prep: how much volume this task contributes. */
  volume_ul?: number;
}

export interface CoordinationCitation {
  reagent: string;
  rcra_code: string | null;
  sources: string[];
}

export interface CoordinationSavings {
  volume_ml?: number;
  prep_events_saved?: number;
  runs_saved?: number;
  hazardous_disposal_events_avoided?: number;
  co2e_kg_range?: [number, number];
}

export interface Coordination {
  id: string;
  type: 'shared_reagent_prep' | 'shared_equipment_run';
  /** Set for shared_reagent_prep. */
  overlap_group?: string;
  /** Set for shared_equipment_run. */
  equipment_group?: string;
  participants: CoordinationParticipant[];
  recommendation: string;
  rationale: string[];
  savings: CoordinationSavings;
  citations: CoordinationCitation[];
  /** True when scheduler successfully aligned all participants in a mutually
   *  free slot. False when alignment was impossible — savings still listed
   *  but the UI should flag it. */
  aligned: boolean;
}

export interface Separation {
  id: string;
  task_ids: string[];
  pair: [string, string];
  severity: 'critical' | 'warning' | 'info' | 'check';
  reason: string;
  /** RCRA codes + EPA URLs collected from epa_cache.json for either side. */
  citations: { waste_group: string; rcra_code: string | null; sources: string[] }[];
}

export interface ImpactWeekly {
  reagent_volume_saved_ml: number;
  hazardous_disposal_events_avoided: number;
  estimated_co2e_kg_range: [number, number];
  prep_events_saved: number;
  equipment_runs_saved: number;
}

export interface ImpactSummary {
  weekly: ImpactWeekly;
  /** Naive ×52 projection if the lab repeats this exact week year-round. */
  annualized_if_repeated: ImpactWeekly;
}

export interface WeekPlanDiagnostics {
  warnings: string[];
  /** Tasks that the scheduler couldn't place (no valid slot). */
  unscheduled: { task_id: string; reason: string }[];
}

export interface WeekPlanResult {
  week_start_iso: string;
  schedule: ScheduledTask[];
  coordinations: Coordination[];
  separations: Separation[];
  impact: ImpactSummary;
  diagnostics: WeekPlanDiagnostics;
}

// ----- Narrated (Layer 4) types — what the LLM narrator emits -----
//
// The narrator is the final layer in the pipeline:
//   engine output (WeekPlanResult)  ->  narrator (Gemini)  ->  NarratedWeekPlanResult
//
// It only ADDS prose fields. It cannot change a number, a citation, a task_id,
// or anything safety-relevant. The deterministic fields below are byte-identical
// copies of what the engine produced; the new `prose` block is the only thing
// the LLM authored.
//
// When Gemini is unavailable or the response fails validation, the narrator
// falls back to deterministic English templates built from the engine's
// `recommendation` / `rationale` / `reason` strings. The shape is the same
// either way; consumers should not branch on `narration.generated`.

/** Prose for a coordination card. All three fields are short, human-readable
 *  English. Numbers in `savings_phrase` are pulled from Coordination.savings,
 *  not invented. */
export interface CoordinationProse {
  /** One-line title, ≤ 90 chars. Names the action ("Prep 60 mL of 70% ethanol once Monday"). */
  headline: string;
  /** 1–3 sentences, ≤ 280 chars. Names the people, days, and reagent / equipment. */
  body: string;
  /** "Saves ~40 mL ethanol and 2 prep events." Always contains at least one digit. */
  savings_phrase: string;
}

/** Prose for a separation warning card. */
export interface SeparationProse {
  /** Imperative title, ≤ 90 chars ("Buffer AL waste must not mix with bleach"). */
  headline: string;
  /** Why + what to do, ≤ 280 chars. */
  body: string;
}

export interface NarratedCoordination extends Coordination {
  prose: CoordinationProse;
}

export interface NarratedSeparation extends Separation {
  prose: SeparationProse;
}

/** Top-level narrated result. Same shape as WeekPlanResult plus prose layer. */
export interface NarratedWeekPlanResult
  extends Omit<WeekPlanResult, 'coordinations' | 'separations'> {
  coordinations: NarratedCoordination[];
  separations: NarratedSeparation[];
  /** One-sentence headline rendered above the impact summary. */
  headline_tagline: string;
  /** Provenance for the narration step. */
  narration: {
    /** True when Gemini produced the prose; false when we fell back to
     *  deterministic templates (no API key, timeout, schema mismatch, etc.). */
    generated: boolean;
    /** Model id when generated=true; null otherwise. */
    model: string | null;
    /** When generated=false, why we fell back. Empty string when generated=true. */
    fallback_reason: string;
  };
}

// ----- Match result (Layer 1) -----

export interface ProtocolMatchCandidate {
  protocol_name: string;
  score: number; // 0..1
  reasons: string[];
}

export interface ProtocolMatchResult {
  /** The chosen protocol_name from /data/seed/protocols_selected.csv,
   *  or null when no candidate cleared the confidence floor. */
  protocol_name: string | null;
  confidence: number; // 0..1
  matched_via: 'filename' | 'keyword' | 'llm' | 'none';
  /** Top-K candidates including the chosen one, ordered by score desc. Useful for
   *  debugging and for the UI to render a disambiguation dropdown when needed. */
  candidates: ProtocolMatchCandidate[];
  /** Free-form note for logs / UI tooltips. */
  notes: string;
}
