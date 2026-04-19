// Pure-code "Layer 2" enrichment.
//
// Input:  protocol_name (one of the 9 in protocols_selected.csv) + sample_count
// Output: EnrichedProtocol — the contract the deterministic engine consumes
//
// What this function does:
//   - Looks up the protocol row, its reagents, its thermal profile (if PCR), and
//     binds each reagent to its term-map row, EPA cache entry, stability row,
//     overlap-rule row, and impact coefficient.
//   - Resolves the protocol's required equipment by mapping its primary_technique
//     to the lab catalog (data/seed/equipment.csv).
//   - Multiplies per-sample volumes by sample_count to get the total volumes the
//     scheduler will reason about.
//
// What this function does NOT do:
//   - Call the LLM. (LLM only produces a `protocol_name`; we take it from there.)
//   - Schedule, batch, or compute waste compatibility — that's the engine's job.
//   - Hit the network. Everything is from the in-memory CSV/JSON caches.
//
// All cross-protocol reasoning (overlap, batching, separations) happens later in
// the deterministic engine, which receives a list of EnrichedProtocols.

import {
  loadEpaCache,
  loadEquipment,
  loadEquipmentTermMap,
  loadImpactCoefficients,
  loadOverlapRules,
  loadProtocolEquipmentRequirements,
  loadProtocolReagents,
  loadProtocols,
  loadReagentStability,
  loadReagentTermMap,
  loadThermalProfiles,
  seedDataVersion,
} from './data';
import type {
  EnrichedProtocol,
  EnrichedReagent,
  EquipmentRequirement,
  ProtocolReagentRow,
  ProtocolSelectedRow,
  ProtocolThermalProfileRow,
  ReagentHazardSummary,
  ReagentTermMapRow,
  ThermalProfile,
} from './types';

export class HydrateError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'HydrateError';
  }
}

export interface HydrateOptions {
  protocol_name: string;
  sample_count: number;
  matched_via?: 'filename' | 'keyword' | 'llm' | 'manual';
}

/** Synchronous because every dependency is in-memory after the first call. */
export function hydrateProtocol(opts: HydrateOptions): EnrichedProtocol {
  const { protocol_name, sample_count } = opts;

  if (!Number.isFinite(sample_count) || sample_count <= 0) {
    throw new HydrateError(
      `sample_count must be a positive number, got ${sample_count}`,
      'INVALID_SAMPLE_COUNT'
    );
  }

  const protocol = findProtocol(protocol_name);
  const reagentRows = loadProtocolReagents().filter(
    (r) => r.protocol_name === protocol_name
  );

  if (reagentRows.length === 0) {
    throw new HydrateError(
      `No rows in protocol_reagents.csv for "${protocol_name}".`,
      'NO_REAGENTS'
    );
  }

  const reagents = reagentRows.map((row) =>
    enrichReagent(row, sample_count, protocol_name)
  );

  const thermal = findThermalProfile(protocol_name);
  const equipment = resolveEquipment(protocol);

  return {
    protocol_name: protocol.protocol_name,
    family: protocol.family,
    vendor: protocol.vendor,
    primary_technique: protocol.primary_technique,
    sample_count,
    sample_count_basis: sample_count,
    reagents,
    equipment_required: equipment,
    thermal_profile: thermal,
    missing_information: [], // populated when a hand-uploaded protocol parses incomplete; empty for seed picks
    provenance: {
      matched_via: opts.matched_via ?? 'manual',
      seed_data_version: seedDataVersion(),
    },
  };
}

// ----- helpers -----

function findProtocol(name: string): ProtocolSelectedRow {
  const row = loadProtocols().find((p) => p.protocol_name === name);
  if (!row) {
    throw new HydrateError(
      `Unknown protocol "${name}" — must match protocols_selected.csv exactly.`,
      'UNKNOWN_PROTOCOL'
    );
  }
  return row;
}

/** Resolve a single reagent from a protocol_reagents row to a fully enriched form. */
function enrichReagent(
  row: ProtocolReagentRow,
  sampleCount: number,
  protocolName: string
): EnrichedReagent {
  const term = findReagentTerm(row.reagent_raw_term, protocolName);
  const volumePerSampleUl = parseNumber(row.volume_per_sample_ul, 0);
  const deadVolumePct = parseNumber(row.dead_volume_pct, 0);
  // Round to 0.1 µL — the seed numbers don't carry more precision than that anyway.
  const volumeTotalUl = Math.round(volumePerSampleUl * sampleCount * 10) / 10;

  const stability = findStability(term.generic_overlap_group);
  const batch = findBatchPrep(term.generic_overlap_group);
  const hazard = findHazard(term.epa_lookup_key);
  const impact = findImpactPerLiter(term.generic_overlap_group);

  return {
    raw_term: row.reagent_raw_term,
    normalized_name: term.normalized_name,
    generic_overlap_group: term.generic_overlap_group,
    stage: term.stage,
    shareable_prep: term.shareable_prep === 'yes',
    hazard_or_handling_flag: term.hazard_or_handling_flag,
    volume_per_sample_ul: volumePerSampleUl,
    dead_volume_pct: deadVolumePct,
    volume_total_ul: volumeTotalUl,
    stability,
    batch_prep: batch,
    hazard,
    impact_per_liter: impact,
  };
}

/** Look up a reagent's term-map entry. Some raw_terms appear in multiple protocols
 *  with the SAME normalized name (e.g. "Proteinase K Solution" in both GeneJET and
 *  MagJET) — the row content is identical, so first match is fine. */
function findReagentTerm(rawTerm: string, protocolName: string): ReagentTermMapRow {
  const map = loadReagentTermMap();
  // Prefer a row whose protocol_examples mentions this protocol — disambiguates the
  // rare cases where two raw_terms collide across families.
  const preferred = map.find(
    (r) =>
      r.raw_term === rawTerm &&
      r.protocol_examples
        .split('|')
        .map((s) => s.trim())
        .includes(protocolName)
  );
  if (preferred) return preferred;

  const fallback = map.find((r) => r.raw_term === rawTerm);
  if (fallback) return fallback;

  throw new HydrateError(
    `Reagent "${rawTerm}" (from "${protocolName}") is missing from reagent_term_map.csv. ` +
      `Add it to the term map before this protocol can be hydrated.`,
    'UNMAPPED_REAGENT'
  );
}

function findStability(overlapGroup: string): EnrichedReagent['stability'] {
  const row = loadReagentStability().find((r) => r.generic_overlap_group === overlapGroup);
  if (!row) return null;
  return {
    stable_hours_after_prep: parseNumber(row.stable_hours_after_prep, 0),
    storage_requirement: row.storage_requirement,
  };
}

function findBatchPrep(overlapGroup: string): EnrichedReagent['batch_prep'] {
  const row = loadOverlapRules().find((r) => r.generic_overlap_group === overlapGroup);
  if (!row || row.can_batch_prep !== 'yes') return null;
  return {
    prep_overhead_ml: parseNumber(row.prep_overhead_ml, 0),
    max_batch_ml: parseNumber(row.max_batch_ml, 0),
    notes: row.notes,
  };
}

function findHazard(epaLookupKey: string): ReagentHazardSummary | null {
  const cache = loadEpaCache();
  const entry = cache[epaLookupKey];
  if (!entry) return null;
  return {
    epa_lookup_key: epaLookupKey,
    epa_classification: entry.epa_classification ?? '',
    rcra_code: entry.rcra_code ?? null,
    incompatibilities: entry.incompatibilities ?? [],
    comptox_hazard_flags: entry.comptox_hazard_flags ?? [],
    classification_by_analogy: entry.classification_by_analogy ?? false,
    sources: entry.sources ?? [],
    cas_entries: normalizeCasEntries(entry.cas_numbers_involved),
    // tri_reportable is boolean | null | undefined in the cache; null/undefined
    // both mean "not asserted by EPA" which we collapse to false for the UI.
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

function findImpactPerLiter(
  overlapGroup: string
): EnrichedReagent['impact_per_liter'] {
  const coeffs = loadImpactCoefficients();
  const entry = coeffs.reagents[overlapGroup];
  if (!entry || !entry.co2e_kg_per_liter) return null;
  return {
    co2e_kg: entry.co2e_kg_per_liter,
    hazardous_disposal_cost_usd: entry.hazardous_disposal_cost_usd_per_liter,
    source_type: entry.source_type ?? 'unknown',
  };
}

function findThermalProfile(protocolName: string): ThermalProfile | null {
  const row = loadThermalProfiles().find((r) => r.protocol_name === protocolName);
  if (!row) return null;
  return {
    initial_denature_temp_c: parseNumber(row.initial_denature_temp_c, 0),
    initial_denature_time_s: parseNumber(row.initial_denature_time_s, 0),
    cycle_denature_temp_c: parseNumber(row.cycle_denature_temp_c, 0),
    cycle_denature_time_s: parseNumber(row.cycle_denature_time_s, 0),
    annealing_temp_c: parseNumber(row.annealing_temp_c, 0),
    annealing_time_s: parseNumber(row.annealing_time_s, 0),
    extension_temp_c: parseNumber(row.extension_temp_c, 0),
    extension_time_s: parseNumber(row.extension_time_s, 0),
    cycles: parseNumber(row.cycles, 0),
    final_extension_temp_c: parseNumber(row.final_extension_temp_c, 0),
    final_extension_time_s: parseNumber(row.final_extension_time_s, 0),
    notes: row.notes ?? '',
  };
}

// ----- equipment resolution -----
//
// Resolution order:
//   1. data/seed/protocol_equipment_requirements.csv — authoritative per-protocol
//      list of equipment + preferred lab-catalog model. Used for every currently
//      seeded protocol.
//   2. Fallback to the legacy TECHNIQUE_EQUIPMENT_GROUPS / equipment.type match
//      if the CSV has no rows for a protocol (e.g. a hand-rolled protocol that
//      skipped the requirements sheet). Kept so older seed bundles still hydrate.

/** Legacy technique -> generic equipment groups map.
 *  Only used when protocol_equipment_requirements.csv has no rows for the
 *  requested protocol. Kept as a safety net for older seed bundles. */
const TECHNIQUE_EQUIPMENT_GROUPS: Record<string, string[]> = {
  spin_column_tissue_purification: ['centrifuge', 'incubator'],
  spin_column_genomic_dna: ['centrifuge', 'incubator'],
  magnetic_bead_genomic_dna: ['magnet_rack_tube', 'incubator'],
  high_fidelity_endpoint_pcr: ['thermocycler'],
  hot_start_endpoint_pcr: ['thermocycler'],
  ready_mix_direct_load_pcr: ['thermocycler'],
  spri_bead_pcr_cleanup: ['magnet_plate_96'],
  magnetic_bead_ngs_cleanup: ['magnet_plate_96', 'magnet_rack_tube'],
  paramagnetic_pcr_cleanup: ['magnet_plate_96'],
};

/** Map a legacy equipment_group to a lab catalog `type`. Only relevant for the
 *  legacy fallback above. */
const EQUIPMENT_GROUP_TO_CATALOG_TYPE: Record<string, string> = {
  thermocycler: 'thermocycler',
  centrifuge: 'microcentrifuge',
  magnet_plate_96: 'magnetic_plate',
  magnet_plate_384: 'magnetic_plate',
  magnet_rack_tube: 'magnetic_rack',
  incubation_mixer: 'heat_block',
  incubator: 'heat_block',
  mixer: 'vortex',
  multichannel_pipette: 'multichannel_pipette',
  automation: 'automation',
};

function resolveEquipment(protocol: ProtocolSelectedRow): EquipmentRequirement[] {
  // Preferred path: explicit per-protocol requirements from the seed CSV.
  const reqs = loadProtocolEquipmentRequirements().filter(
    (r) => r.protocol_name === protocol.protocol_name
  );
  if (reqs.length > 0) {
    const catalog = loadEquipment();
    return reqs.map<EquipmentRequirement>((row) => {
      const lab =
        catalog.find((e) => e.id === row.preferred_model_id) ??
        catalog.find((e) => e.type === row.equipment_type);
      const capacityFromRow = parseNumber(row.samples_per_run_default, 0) || null;
      const capacity = lab
        ? parseNumber(lab.capacity, 0) || capacityFromRow
        : capacityFromRow;
      return {
        equipment_group: row.equipment_type,
        lab_id: lab?.id ?? null,
        capacity,
        batchable: row.batchable_yes_no === 'yes',
        notes: lab
          ? `${lab.model} (capacity ${lab.capacity}, ~${row.run_duration_min_default} min/run)`
          : `No lab catalog entry for preferred_model_id "${row.preferred_model_id}" ` +
            `(equipment_type "${row.equipment_type}").`,
      };
    });
  }

  // Fallback: legacy technique->group mapping for protocols that predate the
  // requirements CSV.
  const groups = TECHNIQUE_EQUIPMENT_GROUPS[protocol.primary_technique];
  if (!groups || groups.length === 0) {
    return [
      {
        equipment_group: 'unknown',
        lab_id: null,
        capacity: null,
        batchable: false,
        notes: `No equipment rows in protocol_equipment_requirements.csv for ` +
          `"${protocol.protocol_name}", and no fallback mapping for technique ` +
          `"${protocol.primary_technique}".`,
      },
    ];
  }

  const catalog = loadEquipment();
  const termMap = loadEquipmentTermMap();

  return groups.map<EquipmentRequirement>((group) => {
    const catalogType = EQUIPMENT_GROUP_TO_CATALOG_TYPE[group] ?? group;
    const lab = catalog.find((e) => e.type === catalogType);
    const term = termMap.find((t) => t.equipment_group === group);

    return {
      equipment_group: group,
      lab_id: lab?.id ?? null,
      capacity: lab ? parseNumber(lab.capacity, 0) || null : null,
      batchable: term ? term.batchable_yes_no === 'yes' : false,
      notes: lab
        ? `${lab.model} (capacity ${lab.capacity})`
        : `No lab catalog entry for equipment_group "${group}" (catalog type "${catalogType}").`,
    };
  });
}

// ----- numeric parsing -----

function parseNumber(raw: string | undefined | null, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
