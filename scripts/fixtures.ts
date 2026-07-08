// Shared test fixtures for the deterministic engine + narrator smoke tests.
//
// After the catalog/hydrate path was removed, tests build EnrichedProtocols the
// same way the live product does: a DraftProtocol (what the PDF parser would
// emit) run through resolveDraft(). No seed protocol_reagents.csv, no LLM call.
// Overlap groups below must exist in data/seed/reagent_term_map.csv so the
// resolver can join stability / batch-prep / hazard / impact data.

import { resolveDraft } from '../lib/engine/resolveDraft';
import type { DraftProtocol, EnrichedProtocol, HydratedTask } from '../lib/engine/types';

function enrich(draft: DraftProtocol, sampleCount: number): EnrichedProtocol {
  return resolveDraft({
    draft,
    confirmations: draft.reagents.map((r) => ({
      raw_term: r.raw_term,
      confirmed_overlap_group: r.proposed_overlap_group,
      volume_per_sample_ul:
        typeof r.volume_per_sample_ul === 'number' ? r.volume_per_sample_ul : 0,
    })),
    sample_count: sampleCount,
  });
}

/** SPRI/AMPure-style amplicon cleanup: beads + ethanol wash + elution. */
export function cleanupProtocol(sampleCount: number): EnrichedProtocol {
  const draft: DraftProtocol = {
    protocol_name: 'AMPure XP-style amplicon cleanup',
    vendor: 'Demo',
    family: 'Bead_cleanup',
    primary_technique: 'SPRI_cleanup_amplicon_96',
    samples_default: sampleCount,
    samples_max: 900,
    reagents: [
      draftReagent('SPRI beads', 90, 10, 'bind', 'paramagnetic_cleanup_beads'),
      draftReagent('fresh 70% ethanol', 400, 5, 'wash', 'ethanol_wash_solution'),
      draftReagent('Elution Buffer', 40, 10, 'elute', 'low_salt_elution'),
    ],
    equipment_required: [
      { equipment_type: 'magnetic_separator', model_hint: '96-well magnetic separator' },
    ],
    thermal_profile: null,
    missing_information: [],
  };
  return enrich(draft, sampleCount);
}

/** Q5-style genotyping PCR: master mix + water, on a thermocycler. */
export function pcrProtocol(sampleCount: number): EnrichedProtocol {
  const draft: DraftProtocol = {
    protocol_name: 'Q5-style genotyping PCR',
    vendor: 'Demo',
    family: 'PCR',
    primary_technique: 'endpoint_pcr_96',
    samples_default: sampleCount,
    samples_max: 900,
    reagents: [
      draftReagent('Q5 master mix', 25, 10, 'setup', 'pcr_master_mix_q5'),
      draftReagent('nuclease-free water', 20, 5, 'setup', 'pcr_reaction_water'),
    ],
    equipment_required: [
      { equipment_type: 'thermocycler', model_hint: 'Bio-Rad C1000' },
    ],
    // A fixed profile so PCR tasks segment together in matcher.segmentByThermalProfile.
    thermal_profile: {
      initial_denature_temp_c: 98,
      initial_denature_time_s: 30,
      cycle_denature_temp_c: 98,
      cycle_denature_time_s: 10,
      annealing_temp_c: 60,
      annealing_time_s: 20,
      extension_temp_c: 72,
      extension_time_s: 30,
      cycles: 30,
      final_extension_temp_c: 72,
      final_extension_time_s: 120,
      notes: '',
    },
    missing_information: [],
  };
  return enrich(draft, sampleCount);
}

/** Pooled sequencing run (MiSeq i100). The load-bearing input is the sample
 *  count that will be pooled onto one flow cell; there are no pipetted
 *  reagents the engine cares about (the reagent kit is a per-run consumable
 *  costed via equipment.csv). Mirrors the user's model: sequencing is a
 *  first-class uploaded protocol, not a derived step. */
export function sequencingProtocol(sampleCount: number): EnrichedProtocol {
  const draft: DraftProtocol = {
    protocol_name: 'MiSeq i100 pooled amplicon sequencing',
    vendor: 'Illumina / UCSD IGM',
    family: 'Sequencing',
    primary_technique: 'pooled_amplicon_sequencing_miseq',
    samples_default: sampleCount,
    samples_max: 384,
    reagents: [],
    equipment_required: [
      { equipment_type: 'sequencer', model_hint: 'Illumina MiSeq i100' },
    ],
    thermal_profile: null,
    missing_information: [],
  };
  return enrich(draft, sampleCount);
}

function draftReagent(
  rawTerm: string,
  volumePerSampleUl: number,
  deadVolumePct: number,
  stage: 'lysis' | 'bind' | 'wash' | 'elute' | 'setup' | 'other',
  overlapGroup: string
): DraftProtocol['reagents'][number] {
  return {
    raw_term: rawTerm,
    volume_per_sample_ul: volumePerSampleUl,
    dead_volume_pct: deadVolumePct,
    proposed_stage: stage,
    proposed_overlap_group: overlapGroup,
    cas_number: null,
    shareable_prep: true,
  };
}

export function task(person: string, protocol: EnrichedProtocol, idx: number): HydratedTask {
  return {
    task_id: `${slug(person)}__${slug(protocol.family)}__${idx}`,
    protocol,
  };
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
