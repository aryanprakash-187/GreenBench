// Coordination candidate generation.
//
// Two passes, both pure functions over the hydrated tasks:
//   1. Reagent overlap → shared_reagent_prep coordinations
//   2. Equipment batching → shared_equipment_run coordinations
//
// This module decides WHAT could be shared. The scheduler decides WHETHER the
// shared event can actually be placed (mutually-free slot, ordering, etc.)
// and flips Coordination.aligned accordingly.

import { gridCo2ePerKwh } from './data';
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
  /** Protocol family of the task that owns this contribution (Bead_cleanup,
   *  DNA_extraction, PCR). Used to keep cross-family reagents out of the same
   *  bucket — e.g. nuclease-free water used in a PCR reaction should never
   *  coordinate with low-salt elution buffer used in a bead cleanup, even
   *  though the term map historically labelled both with the same functional
   *  `low_salt_elution` group. */
  family: string;
}

/** For every (workflow_family, overlap_group), collect all task contributions
 *  whose reagent is marked shareable AND has a batch_prep rule. Emit one
 *  Coordination per (family, group) bucket whenever 2+ tasks contribute.
 *
 *  We include the task's protocol family in the grouping key because the
 *  `generic_overlap_group` from the reagent term map is *functional* (e.g.
 *  "low_salt_elution") and intentionally cross-vendor — so two reagents from
 *  entirely different workflows can land in the same group. A PCR user's
 *  "nuclease-free water" and a bead-cleanup user's "Elution Buffer" are NOT
 *  fungible even though both are labelled `low_salt_elution`: you can't prep
 *  one batch of water and serve both purposes. Family gating prevents that
 *  kind of phantom coordination. */
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
        const family = task.protocol.family;
        const key = `${family}::${reagent.generic_overlap_group}`;
        const list = byGroup.get(key) ?? [];
        list.push({
          person: person.name,
          task_id: task.task_id,
          reagent,
          family,
        });
        byGroup.set(key, list);
      }
    }
  }

  const coordinations: Coordination[] = [];
  let counter = 0;

  for (const [, contribs] of byGroup) {
    const overlapGroup = contribs[0].reagent.generic_overlap_group;
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

    // Ordinal hazard rank (0–3) from the cached EPA hazard class. The scheduler
    // uses it to prioritize higher-disposal-burden coordinations under slot
    // contention. It is a priority weight, not a price — v1 has no cost model.
    const hazardRankValue = hazardRank(contribs);

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
        hazard_rank: hazardRankValue,
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

  // Group by (workflow_family, equipment_group). Family gating is important
  // here because the equipment term map marks generic groups like
  // `liquid_handler` and `plate_sealer` as batchable, which would otherwise
  // pair unrelated protocols on the strength of "both people touched a
  // liquid handler that week". In reality you can't run a PCR reaction setup
  // program and an AMPure cleanup program as a single batched liquid-handler
  // run — the deck layouts and methods are different. Thermocyclers are the
  // one exception: even cross-family PCR-family tasks with the same thermal
  // profile CAN batch, but they're already constrained by family in
  // practice (only PCR-family protocols carry a thermal profile), so the
  // family-equality gate doesn't change their behavior.
  interface EquipMember {
    person: string;
    task: HydratedTask;
    family: string;
    equipment_group: string;
    lab_id: string | null;
    capacity: number | null;
    power_draw_kw_active: number | null;
    run_duration_min: number | null;
    cost_per_run_usd: number | null;
  }
  const byGroup = new Map<string, EquipMember[]>();

  for (const { person, task } of flat) {
    for (const eq of task.protocol.equipment_required) {
      if (!eq.batchable) continue;
      if (!eq.lab_id) continue;
      const family = task.protocol.family;
      const key = `${family}::${eq.equipment_group}`;
      const list = byGroup.get(key) ?? [];
      list.push({
        person,
        task,
        family,
        equipment_group: eq.equipment_group,
        lab_id: eq.lab_id,
        capacity: eq.capacity,
        power_draw_kw_active: eq.power_draw_kw_active,
        run_duration_min: eq.run_duration_min,
        cost_per_run_usd: eq.cost_per_run_usd,
      });
      byGroup.set(key, list);
    }
  }

  const gridFactor = gridCo2ePerKwh();
  const out: Coordination[] = [];
  let counter = 0;

  for (const [, members] of byGroup) {
    if (members.length < 2) continue;
    const group = members[0].equipment_group;

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

      const runsSaved = fits
        ? seg.length - 1
        : Math.max(0, seg.length - Math.ceil(totalSamples / capacity));

      // Item 1 — energy: kWh avoided by consolidating runs. Derived from the
      // catalog row (power × duration), NOT a hardcoded per-equipment value.
      //   kwh_per_run  = power_draw_kw_active × (run_duration_min / 60)
      //   kwh_saved    = runs_saved × kwh_per_run
      //   energy_co2e  = kwh_saved × grid_factor (eGRID CAMX ≈ 0.195 kg/kWh)
      // These are pilot estimates (grid factor + durations are documented
      // assumptions); the UI labels them as such.
      const powerKw = seg[0].power_draw_kw_active ?? 0;
      const runDurationH = (seg[0].run_duration_min ?? 0) / 60;
      const kwhPerRun = powerKw * runDurationH;
      const kwhSaved = runsSaved * kwhPerRun;
      const energyCo2eKg = kwhSaved * gridFactor;

      // Item 2 — dollars: only instruments with a real per-run cost (the
      // sequencer today) contribute. usd_saved = runs_saved × cost_per_run.
      const costPerRun = seg[0].cost_per_run_usd ?? 0;
      const usdSaved = runsSaved * costPerRun;

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
          runs_saved: runsSaved,
          ...(kwhSaved > 0 ? { kwh_saved: round3(kwhSaved) } : {}),
          ...(usdSaved > 0 ? { usd_saved: round2(usdSaved) } : {}),
          // Energy CO2e is a point estimate (single grid factor), so both ends
          // of the range are equal. Folded into the same co2e range the
          // reagent coordinations use so the headline reflects total CO2e.
          ...(energyCo2eKg > 0
            ? { co2e_kg_range: [round3(energyCo2eKg), round3(energyCo2eKg)] as [number, number] }
            : {}),
        },
        // Citations are aggregated from the EPA hazard summaries of every
        // reagent that will be on-deck during the shared run, deduped by
        // epa_lookup_key. The instrument itself doesn't appear in the EPA
        // databases, but the chemistries that meet on it do — and that's what
        // the user is being asked to verify ("am I OK pooling these on one
        // liquid handler / plate sealer?"). Empty array is preserved for
        // shared_equipment_run cards with no enriched hazard data, so the
        // UI's `citations.length > 0` button gate keeps working.
        citations: collectEquipmentCitations(seg.map((m) => m.task)),
        aligned: false,
      });
    }
  }

  return out;
}

function segmentByThermalProfile<T extends { task: HydratedTask }>(
  members: T[]
): T[][] {
  const buckets = new Map<string, T[]>();
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
      cas_entries: h.cas_entries ?? [],
      is_tri_listed: h.is_tri_listed === true,
    });
  }
  return out;
}

/** For shared_equipment_run coordinations, surface the EPA hazard data of
 *  every distinct reagent that lives on the instrument during the batched
 *  run. We dedupe by epa_lookup_key so the same chemistry isn't repeated
 *  across multiple participating tasks. Returns [] when none of the
 *  participating reagents have a hazard summary in the EPA cache — that
 *  matches the prior behavior so the UI's "Show EPA citations" button stays
 *  hidden when we genuinely have nothing to cite. */
function collectEquipmentCitations(
  tasks: HydratedTask[]
): CoordinationCitation[] {
  const seen = new Set<string>();
  const out: CoordinationCitation[] = [];
  for (const task of tasks) {
    for (const reagent of task.protocol.reagents) {
      const h = reagent.hazard;
      if (!h) continue;
      if (seen.has(h.epa_lookup_key)) continue;
      seen.add(h.epa_lookup_key);
      out.push({
        reagent: reagent.normalized_name,
        rcra_code: h.rcra_code,
        sources: h.sources,
        cas_entries: h.cas_entries ?? [],
        is_tri_listed: h.is_tri_listed === true,
      });
    }
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
// ----- Hazard rank (ChangesToBeMadeForPilot.md §1) -----
//
// We have no live reagent prices and no cost model. The only thing we know is
// the EPA hazard *class* (cached in data/epa_cache.json, never looked up live
// at request time). We turn that class into a small ordinal so the scheduler
// can prioritize higher-disposal-burden coordinations under contention. This
// is a priority weight, not money — there are deliberately no dollar amounts.
const HAZARD_RANK = {
  /** EPA RCRA waste code present — regulated hazardous waste. */
  rcra_regulated: 3,
  /** A known-hazardous CompTox flag (flammable, corrosive, toxic, …). */
  hazardous_flag: 2,
  /** EPA TRI-reportable chemical in the bucket. */
  tri_listed: 1,
  /** Low-hazard aqueous default. */
  benign: 0,
} as const;

/** Worst-case hazard rank (0–3) across a coordination's contributing reagents,
 *  from their cached EPA hazard summaries. */
function hazardRank(contribs: ReagentContribution[]): number {
  let rank: number = HAZARD_RANK.benign;
  for (const c of contribs) {
    const h = c.reagent.hazard;
    if (!h) continue;
    // RCRA-listed is the worst rank; short-circuit.
    if (h.rcra_code) return HAZARD_RANK.rcra_regulated;
    if ((h.comptox_hazard_flags ?? []).some((f) => HAZARDOUS_COMPTOX_FLAGS.has(f))) {
      rank = Math.max(rank, HAZARD_RANK.hazardous_flag);
    }
    if (h.is_tri_listed) rank = Math.max(rank, HAZARD_RANK.tri_listed);
  }
  return rank;
}

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
  const totalMl = (totalUl / 1000).toFixed(1);
  const display = contribs[0].reagent.normalized_name;

  // Contributions repeat per task, not per person — e.g. 3 DNA-extraction
  // runs each for Sohini and Vikas is 6 contributions but only 2 people. List
  // people once with a run count instead of naming every task instance
  // (avoids both an unreadable wall of repeated names and, downstream, an
  // LLM narration body that tries to enumerate every instance and blows past
  // its 280-char schema limit — see lib/llm/prompts/narrate.md).
  const runsByPerson = new Map<string, number>();
  for (const c of contribs) {
    runsByPerson.set(c.person, (runsByPerson.get(c.person) ?? 0) + 1);
  }
  const peopleList = Array.from(runsByPerson.entries())
    .map(([person, n]) => (n > 1 ? `${person} (${n} runs)` : person))
    .join(' and ');

  return `Prep ${totalMl} mL of ${display} once instead of ${contribs.length} separate times — covers ${peopleList}.`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
