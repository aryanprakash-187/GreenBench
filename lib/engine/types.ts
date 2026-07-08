// Types for the engine's data layer.
//
// Layered design (matches the LLM-layer architecture in /docs):
//   Layer 1.5: DraftProtocol        <- what the PDF parser (parseProtocol.ts) emits
//   Layer 2:   EnrichedProtocol     <- resolveDraft join of draft + seed CSVs + EPA cache + equipment
//   Layer 3:   WeekPlanResult       <- engine output (deterministic; defined in scheduler.ts later)
//   Layer 4:   NarratedWeekPlanResult<- LLM narrator output (separate pass)
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
  /** Power/energy columns (used to derive per-run kWh; see matcher.ts). */
  power_profile_group?: string;
  power_draw_kw_active?: string;
  power_draw_kw_idle?: string;
  samples_per_run_low?: string;
  samples_per_run_high?: string;
  /** Typical wall-clock run duration in minutes — the basis for the energy
   *  calc (power × duration). NOT the same as the operator's hands-on bench
   *  time (that's estimated in duration.ts). A MiSeq run is ~24 h unattended;
   *  the loading task is far shorter. */
  run_duration_min?: string;
  /** All-in cost of one instrument run in USD. Non-zero only for instruments
   *  with a real per-run consumable/recharge cost (the sequencer today). Pilot
   *  estimate — confirm with the lab. */
  cost_per_run_usd?: string;
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

/** Single CAS-identified chemical in a waste group. */
export interface HazardCas {
  cas: string;
  name?: string;
  role?: string;
  /** EPA CompTox DTXSID, when the data layer has it. Rendered as a plain-text ID
   *  for manual cross-verification; CompTox deep-links are keyed off the CAS. */
  dtxsid?: string;
}

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
  /** Specific CAS-identified chemicals in this waste group. Populated from
   *  `cas_numbers_involved` in epa_cache.json; always an array (possibly empty). */
  cas_entries: HazardCas[];
  /** True when EPA TRI flags at least one chemical in this bucket as reportable.
   *  Sourced from `tri_reportable` in epa_cache.json. UI renders a plain "TRI
   *  listed" badge; cross-verification is manual via the TRI-listed chemicals
   *  page (linked in the footer). */
  is_tri_listed: boolean;
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
  /** Active power draw (kW) of the chosen catalog row. Null when the row has
   *  no power data. Used with run_duration_min to derive per-run kWh. */
  power_draw_kw_active: number | null;
  /** Typical run duration in minutes for the energy calc (see EquipmentRow). */
  run_duration_min: number | null;
  /** All-in USD cost of one run of this instrument (0 for instruments with no
   *  per-run consumable cost; ~$2k for the sequencer). Pilot estimate. */
  cost_per_run_usd: number | null;
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
  /** Specific CAS-identified chemicals that drive the hazard classification. */
  cas_entries: HazardCas[];
  /** True when EPA TRI lists at least one chemical in this bucket as reportable. */
  is_tri_listed: boolean;
}

export interface CoordinationSavings {
  volume_ml?: number;
  prep_events_saved?: number;
  runs_saved?: number;
  hazardous_disposal_events_avoided?: number;
  co2e_kg_range?: [number, number];
  /** Electricity avoided by consolidating instrument runs (kWh). Derived as
   *  runs_saved × power_draw_kw_active × (run_duration_min / 60). Pilot
   *  estimate — grid factor + durations are documented assumptions. */
  kwh_saved?: number;
  /** Dollars avoided by consolidating instrument runs (runs_saved ×
   *  cost_per_run_usd). Non-zero only for instruments with a real per-run
   *  cost — today that's the sequencer. Pilot estimate. */
  usd_saved?: number;
  /** Ordinal hazard rank (0 = benign aqueous … 3 = RCRA-regulated), derived
   *  purely from the cached EPA hazard class. The scheduler ranks coordinations
   *  by this so higher-disposal-burden chemistries win slot contention. It is
   *  a priority weight, NOT a dollar figure — there is no cost model in v1. */
  hazard_rank?: number;
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
  /** RCRA codes + EPA URLs + CAS chemistry collected from epa_cache.json for either side. */
  citations: {
    waste_group: string;
    rcra_code: string | null;
    sources: string[];
    cas_entries: HazardCas[];
    is_tri_listed: boolean;
  }[];
}

export interface ImpactWeekly {
  reagent_volume_saved_ml: number;
  hazardous_disposal_events_avoided: number;
  estimated_co2e_kg_range: [number, number];
  prep_events_saved: number;
  equipment_runs_saved: number;
  /** Electricity avoided across all aligned equipment runs (kWh). Pilot estimate. */
  kwh_saved: number;
  /** Dollars avoided across all aligned equipment runs (sequencing today). Pilot estimate. */
  usd_saved: number;
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

// ----- Draft (Layer 1.5) types — what the LLM PDF parser emits -----
//
// The hackathon-era pipeline relied on a 9-protocol catalog: an upload was
// classified to one of those names and then joined against the seed CSVs by
// hydrateProtocol(). The real product cannot assume the user's PDF is in the
// catalog, so we now have the LLM extract the full structured contents of the
// document and emit a `DraftProtocol`.
//
// A DraftProtocol is intentionally *not* an EnrichedProtocol:
//   - reagents carry only the LLM's PROPOSED overlap group, not a confirmed
//     one. The UI shows a per-reagent confirmation step before any of this
//     reaches the engine.
//   - equipment is a free-text hint, not a resolved catalog row.
//   - hazard data is left empty; resolveDraft() inherits it from the
//     confirmed overlap group's seed CSV / EPA cache entry, or sets it to
//     null + adds a missing_information entry when the user marks a reagent
//     as a new group.
//
// resolveDraft() consumes a DraftProtocol plus a user-confirmed mapping and
// produces the EnrichedProtocol the engine already knows how to schedule.

/** A single reagent as it comes out of the LLM PDF parser. */
export interface DraftReagent {
  /** The reagent name as it appears in the PDF, e.g. "Buffer AL", "Wash Solution". */
  raw_term: string;
  /** Per-sample volume in microliters. null when the document doesn't quantify
   *  it (mineral oil overlays, "add to volume", etc.) — `missing_information`
   *  carries the explanation in that case. */
  volume_per_sample_ul: number | null;
  /** Estimated dead-volume percentage (pipetting overhead). The LLM may
   *  estimate; if it doesn't have a reasonable guess it sets this to null
   *  and `resolveDraft` falls back to the overlap group's seed default. */
  dead_volume_pct: number | null;
  /** Workflow stage; one of "lysis" | "bind" | "wash" | "elute" | "setup" |
   *  "other". Used by the UI confirmation step and as a hint when the
   *  reagent doesn't match a known overlap group. */
  proposed_stage: string;
  /** The LLM's guess for the closest existing `generic_overlap_group` from
   *  the closed vocabulary, or the literal string `"new"` to indicate the
   *  reagent has no obvious analog in the seed term map. */
  proposed_overlap_group: string;
  /** Optional CAS Registry Number when the document lists one (vendor SDS,
   *  reagent ingredient table, etc.). Stored so a future CTX lookup can
   *  resolve hazard data without a re-parse. */
  cas_number: string | null;
  /** True when the LLM thinks this reagent is shareable across multiple
   *  identical tasks. Defaults to the closed-vocabulary overlap group's
   *  `shareable_prep` value; `"new"` groups default to false. */
  shareable_prep: boolean;
}

/** A single piece of equipment hinted by the PDF parser. */
export interface DraftEquipmentHint {
  /** Functional type, e.g. "thermocycler", "centrifuge", "magnetic_separator",
   *  "liquid_handler". The resolver does a fuzzy match against equipment.csv. */
  equipment_type: string;
  /** Free-text model hint pulled from the PDF, e.g. "Thermo KingFisher Flex"
   *  or "Bio-Rad C1000". May be empty when the doc only says "thermocycler". */
  model_hint: string;
}

/** A structured "we couldn't find this in the PDF; please confirm" item. */
export interface DraftMissingInformation {
  field: string;
  why: string;
}

/** Output of `parseProtocolFromPdf`. The shape mirrors EnrichedProtocol in
 *  spirit but stays pre-resolution: every field that requires a join against
 *  the seed term map / EPA cache / equipment catalog is left as the LLM's
 *  raw guess, to be resolved by `resolveDraft` after the user confirms. */
export interface DraftProtocol {
  /** Human-readable protocol title; falls back to the filename when the
   *  PDF doesn't have a clearer title. */
  protocol_name: string;
  /** Vendor name when visible on the document; empty string otherwise. */
  vendor: string;
  /** Coarse family bucket. Restricted to the engine's existing families plus
   *  "Sequencing" (a pooled instrument run, e.g. MiSeq — the load-bearing
   *  input is sample count, not reagents) and "Other" for novel workflows. */
  family: 'DNA_extraction' | 'PCR' | 'Bead_cleanup' | 'Sequencing' | 'Other';
  /** Short slug describing the technique; free-text but the LLM is asked to
   *  reuse the seed value when one fits. Examples: "spin_column_dna_extraction",
   *  "endpoint_pcr_96", "magnetic_cleanup_single". */
  primary_technique: string;
  /** Sample count the protocol is written for. The user can override; the
   *  engine ultimately schedules against the user-provided sample count. */
  samples_default: number;
  /** Maximum sample count the protocol claims to support, if stated. */
  samples_max: number;
  reagents: DraftReagent[];
  equipment_required: DraftEquipmentHint[];
  /** PCR-only. null for extraction and cleanup. */
  thermal_profile: ThermalProfile | null;
  /** Things the LLM couldn't find or quantify in the PDF. */
  missing_information: DraftMissingInformation[];
}

/** Per-reagent user choice from the confirmation UI. One entry per draft
 *  reagent (matched by `raw_term` since it's unique within a protocol). */
export interface ReagentConfirmation {
  raw_term: string;
  /** The user-confirmed `generic_overlap_group` for this reagent. May be the
   *  LLM's proposal, a different existing group, or the literal string `"new"`
   *  when the user explicitly accepts the reagent as a freshly-coined group. */
  confirmed_overlap_group: string;
  /** Final per-sample volume in microliters. The UI defaults this to the
   *  LLM's value; a user can override if the LLM was unsure or wrong. */
  volume_per_sample_ul: number;
}

