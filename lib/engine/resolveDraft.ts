// Resolve a parsed DraftProtocol + user-confirmed overlap-group mappings
// into the EnrichedProtocol shape the deterministic engine consumes.
//
// This is the second half of the "PDF in, schedule out" pipeline:
//
//   parseProtocolFromPdf()  ->  DraftProtocol           (Layer 1.5)
//   user confirms overlap groups in the UI              (Layer 1.6)
//   resolveDraft()         ->  EnrichedProtocol         (Layer 2)
//   planWeek()             ->  WeekPlanResult           (Layer 3)
//
// Everything in here is pure code, no LLM, no fs writes. It mirrors the
// joins hydrateProtocol() does for a catalog protocol, but works off the
// LLM's extracted draft + the user's confirmations rather than the seed
// reagents CSV.

import {
  loadEpaCache,
  loadEquipment,
  loadImpactCoefficients,
  loadOverlapRules,
  loadReagentStability,
  loadReagentTermMap,
  seedDataVersion,
} from './data';
import type {
  DraftProtocol,
  DraftReagent,
  EnrichedProtocol,
  EnrichedReagent,
  EquipmentRequirement,
  MissingInformation,
  ReagentConfirmation,
  ReagentHazardSummary,
  ReagentTermMapRow,
} from './types';

export class ResolveDraftError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ResolveDraftError';
  }
}

export interface ResolveDraftOptions {
  draft: DraftProtocol;
  /** One confirmation per draft reagent (by raw_term). Missing entries cause
   *  the resolver to fall back to the LLM's `proposed_overlap_group`. */
  confirmations: ReagentConfirmation[];
  /** Final sample count the user is running. Drives volume_total_ul. */
  sample_count: number;
}

export function resolveDraft(opts: ResolveDraftOptions): EnrichedProtocol {
  const { draft, sample_count } = opts;
  if (!Number.isFinite(sample_count) || sample_count <= 0) {
    throw new ResolveDraftError(
      `sample_count must be a positive number; got ${sample_count}`,
      'INVALID_SAMPLE_COUNT'
    );
  }

  const byRawTerm = new Map<string, ReagentConfirmation>();
  for (const c of opts.confirmations ?? []) {
    byRawTerm.set(c.raw_term, c);
  }

  // Carry forward LLM-flagged missing fields; we may add to this list as we
  // resolve (e.g. "user chose `new` for Buffer X — no hazard data").
  const missing: MissingInformation[] = draft.missing_information.map((m) => ({
    field: m.field,
    why_needed: m.why,
    substituted_value: null,
  }));

  const reagents: EnrichedReagent[] = draft.reagents.map((r) =>
    resolveReagent(r, byRawTerm.get(r.raw_term), sample_count, missing)
  );

  const equipment_required = resolveEquipment(draft, missing);

  return {
    protocol_name: draft.protocol_name,
    family: draft.family,
    vendor: draft.vendor,
    primary_technique: draft.primary_technique,
    sample_count,
    sample_count_basis: sample_count,
    reagents,
    equipment_required,
    thermal_profile: draft.thermal_profile,
    missing_information: missing,
    provenance: {
      matched_via: 'llm',
      seed_data_version: seedDataVersion(),
    },
  };
}

// ----- reagent resolution -----

function resolveReagent(
  draft: DraftReagent,
  confirmation: ReagentConfirmation | undefined,
  sampleCount: number,
  missing: MissingInformation[]
): EnrichedReagent {
  const confirmedGroup =
    confirmation?.confirmed_overlap_group ?? draft.proposed_overlap_group ?? 'new';

  // Volume falls back to the LLM's value when the user didn't override; if
  // both are null/undefined we treat the reagent as un-quantified (0) and
  // record a missing_information entry so the UI can prompt.
  const volumePerSampleUl =
    confirmation?.volume_per_sample_ul ??
    (typeof draft.volume_per_sample_ul === 'number' ? draft.volume_per_sample_ul : null);

  let resolvedVolumePerSampleUl: number;
  if (volumePerSampleUl == null) {
    resolvedVolumePerSampleUl = 0;
    missing.push({
      field: `reagents[${draft.raw_term}].volume_per_sample_ul`,
      why_needed:
        'The PDF did not state a per-sample volume; the engine will skip volume-based savings for this reagent until the user provides one.',
      substituted_value: '0',
    });
  } else {
    resolvedVolumePerSampleUl = volumePerSampleUl;
  }

  const deadVolumePct =
    typeof draft.dead_volume_pct === 'number' ? draft.dead_volume_pct : 0;

  const volumeTotalUl = Math.round(resolvedVolumePerSampleUl * sampleCount * 10) / 10;

  const groupInfo = lookupGroupInfo(confirmedGroup);

  // For known groups, pull a normalized name from a representative term-map row;
  // for "new" / unknown groups, the user's raw_term is the most informative
  // label we have.
  const normalizedName = groupInfo.representativeNormalizedName ?? draft.raw_term;

  const shareablePrep =
    confirmation == null
      ? draft.shareable_prep
      : // The UI doesn't (yet) let users override shareable_prep; if the user
        // confirmed a known overlap group we trust the seed CSV's flag, since
        // it encodes carefully-curated cross-vendor rules. For a `new` group
        // we trust the LLM's guess.
        confirmedGroup === 'new'
        ? draft.shareable_prep
        : groupInfo.representativeShareablePrep ?? draft.shareable_prep;

  const stage = groupInfo.representativeStage ?? draft.proposed_stage;
  const hazardOrHandling =
    groupInfo.representativeHazardOrHandling ?? '';

  // For `new` groups there is no curated EPA / stability / impact data to
  // inherit. We surface a single missing_information entry so the UI can
  // prompt the user (or the lab admin) to fill in pilot-curated data later.
  if (confirmedGroup === 'new') {
    missing.push({
      field: `reagents[${draft.raw_term}].overlap_group`,
      why_needed:
        'User marked this reagent as a new overlap group. The engine has no hazard / stability / impact data; coordination opportunities will be limited until the group is added to the seed map.',
      substituted_value: 'new',
    });
  }

  return {
    raw_term: draft.raw_term,
    normalized_name: normalizedName,
    generic_overlap_group: confirmedGroup,
    stage,
    shareable_prep: shareablePrep,
    hazard_or_handling_flag: hazardOrHandling,
    volume_per_sample_ul: resolvedVolumePerSampleUl,
    dead_volume_pct: deadVolumePct,
    volume_total_ul: volumeTotalUl,
    stability: lookupStability(confirmedGroup),
    batch_prep: lookupBatchPrep(confirmedGroup),
    hazard: lookupHazardForGroup(confirmedGroup),
    impact_per_liter: lookupImpactPerLiter(confirmedGroup),
  };
}

// ----- group lookups -----

interface GroupInfo {
  representativeNormalizedName: string | null;
  representativeStage: string | null;
  representativeHazardOrHandling: string | null;
  representativeShareablePrep: boolean | null;
}

function lookupGroupInfo(group: string): GroupInfo {
  if (group === 'new') {
    return {
      representativeNormalizedName: null,
      representativeStage: null,
      representativeHazardOrHandling: null,
      representativeShareablePrep: null,
    };
  }
  const map = loadReagentTermMap();
  const row = map.find((r) => r.generic_overlap_group === group);
  if (!row) {
    return {
      representativeNormalizedName: null,
      representativeStage: null,
      representativeHazardOrHandling: null,
      representativeShareablePrep: null,
    };
  }
  return {
    representativeNormalizedName: row.normalized_name,
    representativeStage: row.stage,
    representativeHazardOrHandling: row.hazard_or_handling_flag,
    representativeShareablePrep: row.shareable_prep === 'yes',
  };
}

function lookupStability(group: string): EnrichedReagent['stability'] {
  if (group === 'new') return null;
  const row = loadReagentStability().find((r) => r.generic_overlap_group === group);
  if (!row) return null;
  const hours = Number(row.stable_hours_after_prep);
  return {
    stable_hours_after_prep: Number.isFinite(hours) ? hours : 0,
    storage_requirement: row.storage_requirement ?? '',
  };
}

function lookupBatchPrep(group: string): EnrichedReagent['batch_prep'] {
  if (group === 'new') return null;
  const row = loadOverlapRules().find((r) => r.generic_overlap_group === group);
  if (!row || row.can_batch_prep !== 'yes') return null;
  return {
    prep_overhead_ml: numberOr(row.prep_overhead_ml, 0),
    max_batch_ml: numberOr(row.max_batch_ml, 0),
    notes: row.notes ?? '',
  };
}

function lookupHazardForGroup(group: string): ReagentHazardSummary | null {
  if (group === 'new') return null;
  // The seed term map's `epa_lookup_key` column maps overlap groups to
  // hazard cache entries. Most groups use the same key as their group name
  // (and the cache is keyed accordingly), but the map is the authoritative
  // source — look up by group, take the first row's epa_lookup_key.
  const termRow = loadReagentTermMap().find(
    (r) => r.generic_overlap_group === group
  );
  const epaKey = termRow?.epa_lookup_key ?? group;
  const cache = loadEpaCache();
  const entry = cache[epaKey];
  if (!entry) return null;
  return {
    epa_lookup_key: epaKey,
    epa_classification: entry.epa_classification ?? '',
    rcra_code: entry.rcra_code ?? null,
    incompatibilities: entry.incompatibilities ?? [],
    comptox_hazard_flags: entry.comptox_hazard_flags ?? [],
    classification_by_analogy: entry.classification_by_analogy ?? false,
    sources: entry.sources ?? [],
    cas_entries: normalizeCasEntries(entry.cas_numbers_involved),
    is_tri_listed: entry.tri_reportable === true,
  };
}

function normalizeCasEntries(
  raw:
    | Array<string | { cas: string; name?: string; role?: string; dtxsid?: string }>
    | undefined
): { cas: string; name?: string; role?: string; dtxsid?: string }[] {
  if (!raw || !Array.isArray(raw)) return [];
  const out: { cas: string; name?: string; role?: string; dtxsid?: string }[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const cas = item.trim();
      if (cas) out.push({ cas });
    } else if (item && typeof item === 'object' && typeof item.cas === 'string') {
      const cas = item.cas.trim();
      if (!cas) continue;
      out.push({
        cas,
        ...(item.name ? { name: item.name } : {}),
        ...(item.role ? { role: item.role } : {}),
        ...(item.dtxsid ? { dtxsid: item.dtxsid } : {}),
      });
    }
  }
  return out;
}

function lookupImpactPerLiter(group: string): EnrichedReagent['impact_per_liter'] {
  if (group === 'new') return null;
  const coeffs = loadImpactCoefficients();
  const entry = coeffs.reagents[group];
  if (!entry || !entry.co2e_kg_per_liter) return null;
  return {
    co2e_kg: entry.co2e_kg_per_liter,
    hazardous_disposal_cost_usd: entry.hazardous_disposal_cost_usd_per_liter,
    source_type: entry.source_type ?? 'unknown',
  };
}

// ----- equipment resolution -----

/** Type alias keeps the mapping tables compact. */
type EquipType = string;

/** Fuzzy match table from free-text PDF equipment terms to lab catalog
 *  `type` values. Keys are matched as case-insensitive substrings. */
const TYPE_ALIASES: Array<[RegExp, EquipType]> = [
  [/thermocycler|pcr\s*(?:machine|block|cycler)|thermal\s*cycler/i, 'thermocycler'],
  [/magnetic\s*(?:separator|plate|rack|stand)|magsep|sprigplate/i, 'magnetic_separator'],
  [/plate\s*centrifuge|swing[\s-]?bucket|microplate\s*centrifuge/i, 'centrifuge'],
  [/microcentrifuge|spin\s*column\s*centrifuge/i, 'centrifuge'],
  [/centrifuge/i, 'centrifuge'],
  [/liquid\s*handler|kingfisher|biomek|hamilton\s*star|qiacube|epmotion/i, 'liquid_handler'],
  [/sequencer|sequencing|miseq|novaseq|nextseq|iseq|hiseq|illumina|flow\s*cell/i, 'sequencer'],
  [/plate\s*sealer/i, 'plate_sealer'],
  [/thermomixer|heat\s*block|incubator\s*shaker/i, 'support_device'],
  [/vortex|mixer/i, 'vortex'],
];

function resolveEquipment(
  draft: DraftProtocol,
  missing: MissingInformation[]
): EquipmentRequirement[] {
  const catalog = loadEquipment();
  const seen = new Set<string>();
  const out: EquipmentRequirement[] = [];

  for (const hint of draft.equipment_required) {
    const catalogType = normalizeEquipmentType(hint.equipment_type, hint.model_hint);

    if (!catalogType) {
      // We couldn't map the free-text hint to a known lab type — record it
      // and emit an "unknown" entry. The scheduler tolerates unknown
      // equipment_group (no reservation; warning instead of hard miss).
      missing.push({
        field: `equipment_required[${hint.equipment_type}].type`,
        why_needed: `Could not map "${hint.equipment_type}" (${hint.model_hint || 'no model hint'}) to a known lab equipment type.`,
        substituted_value: 'unknown',
      });
      out.push({
        equipment_group: hint.equipment_type || 'unknown',
        lab_id: null,
        capacity: null,
        batchable: false,
        power_draw_kw_active: null,
        run_duration_min: null,
        cost_per_run_usd: null,
        notes: `LLM hint "${hint.equipment_type}" did not match any known equipment type.`,
      });
      continue;
    }

    // Skip duplicates that the LLM may have emitted by stage (e.g. two
    // "thermocycler" entries for separate amplification rounds).
    if (seen.has(catalogType)) continue;
    seen.add(catalogType);

    const modelMatch = hint.model_hint
      ? catalog.find(
          (c) =>
            c.type === catalogType &&
            c.model.toLowerCase().includes(hint.model_hint.toLowerCase())
        )
      : undefined;
    const lab = modelMatch ?? catalog.find((c) => c.type === catalogType);

    out.push({
      equipment_group: catalogType,
      lab_id: lab?.id ?? null,
      capacity: lab ? numberOr(lab.capacity, 0) || null : null,
      batchable: isBatchable(catalogType),
      power_draw_kw_active: lab ? numberOr(lab.power_draw_kw_active, 0) || null : null,
      run_duration_min: lab ? numberOr(lab.run_duration_min, 0) || null : null,
      cost_per_run_usd: lab ? numberOr(lab.cost_per_run_usd, 0) : null,
      notes: lab
        ? `${lab.model} (capacity ${lab.capacity})`
        : `No lab catalog entry matched type "${catalogType}". Add it before scheduling can reserve this instrument.`,
    });
  }

  return out;
}

function normalizeEquipmentType(
  type: string,
  modelHint: string
): EquipType | null {
  const haystack = `${type} ${modelHint}`;
  for (const [re, t] of TYPE_ALIASES) {
    if (re.test(haystack)) return t;
  }
  // Last chance: an exact substring match of the type string against the
  // catalog's known types. Cheap and safe — if the LLM emitted the right
  // word, we honor it.
  const known = new Set(loadEquipment().map((e) => e.type));
  const lowered = type.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (known.has(lowered)) return lowered;
  return null;
}

function isBatchable(type: EquipType): boolean {
  // The equipment.csv schema doesn't carry a batchable flag, so we default
  // by type. These match the equipment_term_map.csv's batchable_yes_no
  // column for the corresponding raw terms.
  switch (type) {
    case 'thermocycler':
    case 'magnetic_separator':
    case 'centrifuge':
    case 'liquid_handler':
    case 'plate_sealer':
    case 'support_device':
    case 'sequencer':
      return true;
    case 'vortex':
      return false;
    default:
      return false;
  }
}

// ----- utilities -----

function numberOr(raw: string | number | undefined | null, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Test-only export so unit tests can verify the equipment alias rules
 *  without exercising the full draft pipeline. */
export const __test = {
  normalizeEquipmentType,
  isBatchable,
};

/** Re-export `ReagentTermMapRow` to silence the "unused import" lint when
 *  callers want the type only through this module rather than from
 *  `engine/types`. */
export type { ReagentTermMapRow };
