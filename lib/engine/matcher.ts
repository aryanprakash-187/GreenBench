// Coordination candidate generation.
//
// Two passes, both pure functions over the hydrated tasks:
//   1. Reagent overlap → shared_reagent_prep coordinations
//   2. Equipment batching → shared_equipment_run coordinations
//
// This module decides WHAT could be shared. The scheduler decides WHETHER the
// shared event can actually be placed (mutually-free slot, ordering, etc.)
// and flips Coordination.aligned accordingly.

import type {
  Coordination,
  CoordinationCitation,
  EnrichedReagent,
  HydratedTask,
} from './types';

interface PersonView {
  name: string;
  tasks: HydratedTask[];
}

// ----- Reagent overlap -----

interface ReagentContribution {
  person: string;
  task_id: string;
  reagent: EnrichedReagent;
}

/** For every (overlap_group), collect all task contributions whose reagent is
 *  marked shareable AND has a batch_prep rule. Emit one Coordination per
 *  group whenever 2+ tasks contribute. */
export function buildReagentCoordinations(
  people: PersonView[]
): Coordination[] {
  const byGroup = new Map<string, ReagentContribution[]>();

  for (const person of people) {
    for (const task of person.tasks) {
      for (const reagent of task.protocol.reagents) {
        if (!reagent.shareable_prep) continue;
        if (!reagent.batch_prep) continue;
        if (reagent.volume_total_ul <= 0) continue; // mineral oil overlay etc.
        const list = byGroup.get(reagent.generic_overlap_group) ?? [];
        list.push({
          person: person.name,
          task_id: task.task_id,
          reagent,
        });
        byGroup.set(reagent.generic_overlap_group, list);
      }
    }
  }

  const coordinations: Coordination[] = [];
  let counter = 0;

  for (const [overlapGroup, contribs] of byGroup) {
    // Need 2+ distinct tasks to coordinate.
    const taskIds = new Set(contribs.map((c) => c.task_id));
    if (taskIds.size < 2) continue;

    const totalUl = contribs.reduce((s, c) => s + c.reagent.volume_total_ul, 0);

    // Cap to max_batch_ml from overlap_rules.csv (read off any contributor —
    // they all share the same batch_prep row by construction).
    const batchPrep = contribs[0].reagent.batch_prep!;
    const maxBatchUl = batchPrep.max_batch_ml * 1000;
    if (maxBatchUl > 0 && totalUl > maxBatchUl) {
      // Still emit, but flag so the user knows we'd hit the batch ceiling.
      // The scheduler doesn't try to split — that's a stretch.
    }

    // Savings model: if we prepped separately we'd waste each task's dead
    // volume; combining means one prep with `prep_overhead_ml` waste.
    // savedMl = sum(deadOverheadMl per task) − prep_overhead_ml
    const perTaskDeadMl = contribs.map(
      (c) =>
        (c.reagent.volume_total_ul *
          (c.reagent.dead_volume_pct || 0)) /
        100 /
        1000
    );
    const savedMl = Math.max(
      0,
      perTaskDeadMl.reduce((s, x) => s + x, 0) - batchPrep.prep_overhead_ml
    );

    const stability = contribs[0].reagent.stability;
    const hazardousReagent = isHazardousByContribs(contribs);

    // CO2e: per-liter coefficient × saved volume in liters. Only one reagent
    // class per overlap_group, so any contributor is fine.
    const impactPerL = contribs[0].reagent.impact_per_liter;
    const co2eRange: [number, number] | undefined = impactPerL
      ? [
          (impactPerL.co2e_kg.low * savedMl) / 1000,
          (impactPerL.co2e_kg.high * savedMl) / 1000,
        ]
      : undefined;

    const citations = collectReagentCitations(contribs);

    coordinations.push({
      id: `coord_reagent_${counter++}_${slug(overlapGroup)}`,
      type: 'shared_reagent_prep',
      overlap_group: overlapGroup,
      participants: contribs.map((c) => ({
        person: c.person,
        task_id: c.task_id,
        volume_ul: c.reagent.volume_total_ul,
      })),
      recommendation: synthesizeReagentRecommendation(
        overlapGroup,
        contribs,
        totalUl
      ),
      rationale: [
        `Combined volume needed: ${(totalUl / 1000).toFixed(1)} mL across ${contribs.length} task contributions.`,
        stability
          ? `Stability window: ${stability.stable_hours_after_prep}h after prep (${stability.storage_requirement}).`
          : 'Stability window unknown for this overlap group.',
        batchPrep.notes ? `Batching note: ${batchPrep.notes}` : '',
        maxBatchUl > 0 && totalUl > maxBatchUl
          ? `Combined volume exceeds the batching ceiling (${batchPrep.max_batch_ml} mL); recommendation is advisory only.`
          : '',
      ].filter(Boolean),
      savings: {
        volume_ml: round1(savedMl),
        prep_events_saved: contribs.length - 1,
        hazardous_disposal_events_avoided: hazardousReagent
          ? contribs.length - 1
          : 0,
        co2e_kg_range: co2eRange
          ? [round3(co2eRange[0]), round3(co2eRange[1])]
          : undefined,
      },
      citations,
      aligned: false, // scheduler flips this if alignment succeeds
    });
  }

  return coordinations;
}

// ----- Equipment batching -----

/** For every equipment_group, group tasks together. If any 2+ tasks share the
 *  same group AND (for thermocyclers) match thermal profile AND combined
 *  sample count fits in capacity, emit a shared_equipment_run coordination. */
export function buildEquipmentCoordinations(
  people: PersonView[]
): Coordination[] {
  // Flatten to (person, task) tuples for grouping convenience.
  const flat: { person: string; task: HydratedTask }[] = [];
  for (const p of people) for (const t of p.tasks) flat.push({ person: p.name, task: t });

  // Group by equipment_group (a task can use multiple groups; emit once per).
  const byGroup = new Map<
    string,
    { person: string; task: HydratedTask; lab_id: string | null; capacity: number | null }[]
  >();

  for (const { person, task } of flat) {
    for (const eq of task.protocol.equipment_required) {
      // We only batch on equipment that the term map says is batchable AND
      // that resolved to a real lab catalog row.
      if (!eq.batchable) continue;
      if (!eq.lab_id) continue;
      const list = byGroup.get(eq.equipment_group) ?? [];
      list.push({ person, task, lab_id: eq.lab_id, capacity: eq.capacity });
      byGroup.set(eq.equipment_group, list);
    }
  }

  const out: Coordination[] = [];
  let counter = 0;

  for (const [group, members] of byGroup) {
    if (members.length < 2) continue;

    // For thermocyclers, segment by thermal_profile equality.
    const segments =
      group === 'thermocycler'
        ? segmentByThermalProfile(members)
        : [members];

    for (const seg of segments) {
      if (seg.length < 2) continue;

      const totalSamples = seg.reduce((s, m) => s + m.task.protocol.sample_count, 0);
      const capacity = seg[0].capacity ?? Infinity;
      const fits = totalSamples <= capacity;

      out.push({
        id: `coord_equip_${counter++}_${slug(group)}`,
        type: 'shared_equipment_run',
        equipment_group: group,
        participants: seg.map((m) => ({
          person: m.person,
          task_id: m.task.task_id,
        })),
        recommendation: fits
          ? `Run ${seg.length} tasks together on ${group} (combined ${totalSamples} samples, capacity ${capacity}).`
          : `${seg.length} tasks need ${group} but combined ${totalSamples} samples exceed capacity ${capacity}; consider 2 batched runs instead of ${seg.length} separate.`,
        rationale: [
          `Equipment group: ${group} (lab id ${seg[0].lab_id}).`,
          group === 'thermocycler'
            ? 'Thermal profile matches across all participants.'
            : 'No per-instrument settings to match for this equipment type.',
          fits
            ? `Combined ${totalSamples} samples ≤ capacity ${capacity}.`
            : `Combined ${totalSamples} samples > capacity ${capacity} — partial batching only.`,
        ],
        savings: {
          runs_saved: fits ? seg.length - 1 : Math.max(0, seg.length - Math.ceil(totalSamples / capacity)),
        },
        citations: [],
        aligned: false,
      });
    }
  }

  return out;
}

function segmentByThermalProfile(
  members: { person: string; task: HydratedTask; lab_id: string | null; capacity: number | null }[]
): { person: string; task: HydratedTask; lab_id: string | null; capacity: number | null }[][] {
  const buckets = new Map<string, typeof members>();
  for (const m of members) {
    const key = thermalKey(m.task);
    const list = buckets.get(key) ?? [];
    list.push(m);
    buckets.set(key, list);
  }
  return [...buckets.values()];
}

function thermalKey(task: HydratedTask): string {
  const t = task.protocol.thermal_profile;
  if (!t) return 'no_profile';
  // Round-trip through JSON for cheap structural equality.
  return JSON.stringify([
    t.cycles,
    t.cycle_denature_temp_c,
    t.cycle_denature_time_s,
    t.annealing_temp_c,
    t.annealing_time_s,
    t.extension_temp_c,
    t.extension_time_s,
  ]);
}

// ----- helpers -----

function collectReagentCitations(
  contribs: ReagentContribution[]
): CoordinationCitation[] {
  // De-dup by epa_lookup_key — the citation is per-bucket, not per-task.
  const seen = new Set<string>();
  const out: CoordinationCitation[] = [];
  for (const c of contribs) {
    const h = c.reagent.hazard;
    if (!h) continue;
    if (seen.has(h.epa_lookup_key)) continue;
    seen.add(h.epa_lookup_key);
    out.push({
      reagent: c.reagent.normalized_name,
      rcra_code: h.rcra_code,
      sources: h.sources,
    });
  }
  return out;
}

/** Comptox hazard flags that, when set on a reagent's EPA cache entry, mean
 *  separate prep would generate a hazardous disposal event. We deliberately
 *  do NOT include benign tags like `enzyme_master_mix`, `contains_tracking_dye`,
 *  `low_hazard_aqueous`, `enzyme_solution`, or `solid_liquid_bead_waste` —
 *  those would inflate the headline. */
const HAZARDOUS_COMPTOX_FLAGS = new Set([
  'flammable_solvent',
  'chaotropic_salt',
  'bleach_incompatibility',
  'strong_oxidizer',
  'corrosive',
  'toxic',
]);

/** A coordination is hazardous if at least one contributing reagent's EPA
 *  hazard summary either carries an RCRA waste code (the EPA's own
 *  classification of regulated hazardous waste) or a known hazardous Comptox
 *  flag. This replaces the older substring heuristic that incorrectly
 *  classified every PCR master mix as hazardous on the strength of the
 *  literal substring `master_mix`. */
function isHazardousByContribs(contribs: ReagentContribution[]): boolean {
  for (const c of contribs) {
    const h = c.reagent.hazard;
    if (!h) continue;
    if (h.rcra_code) return true;
    if ((h.comptox_hazard_flags ?? []).some((f) => HAZARDOUS_COMPTOX_FLAGS.has(f))) {
      return true;
    }
  }
  return false;
}

function synthesizeReagentRecommendation(
  group: string,
  contribs: ReagentContribution[],
  totalUl: number
): string {
  const taskList = contribs
    .map((c) => `${c.person}'s ${shortProtocol(c.task_id)}`)
    .join(', ');
  const totalMl = (totalUl / 1000).toFixed(1);
  const display = contribs[0].reagent.normalized_name;
  return `Prep ${totalMl} mL of ${display} (${group}) once; covers ${taskList}.`;
}

function shortProtocol(taskId: string): string {
  // task_id pattern is "<person>__<protocolslug>__<n>"; surface the middle.
  const parts = taskId.split('__');
  return parts.length >= 2 ? parts[1] : taskId;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
