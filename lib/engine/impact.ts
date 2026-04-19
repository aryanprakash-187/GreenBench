// Roll up the savings reported on each Coordination into a week-level summary.
//
// Inputs are already in physical units — the matcher computed savedMl,
// prep_events_saved, runs_saved, hazardous_disposal_events_avoided, and
// per-coordination CO2e ranges. This module just sums them and projects to
// the annualized case (×52 if the same week were repeated).
//
// Only coordinations the scheduler actually aligned contribute to the
// headline numbers. Unaligned recommendations still surface in the per-card
// UI (with an "advisory" badge), but counting their savings in the rollup
// would overstate what the lab actually pulled off this week.

import type { Coordination, ImpactSummary, ImpactWeekly } from './types';

export function rollupImpact(coordinations: Coordination[]): ImpactSummary {
  const weekly: ImpactWeekly = {
    reagent_volume_saved_ml: 0,
    hazardous_disposal_events_avoided: 0,
    estimated_co2e_kg_range: [0, 0],
    prep_events_saved: 0,
    equipment_runs_saved: 0,
  };

  for (const c of coordinations) {
    if (!c.aligned) continue;
    const s = c.savings;
    if (s.volume_ml) weekly.reagent_volume_saved_ml += s.volume_ml;
    if (s.prep_events_saved) weekly.prep_events_saved += s.prep_events_saved;
    if (s.runs_saved) weekly.equipment_runs_saved += s.runs_saved;
    if (s.hazardous_disposal_events_avoided)
      weekly.hazardous_disposal_events_avoided += s.hazardous_disposal_events_avoided;
    if (s.co2e_kg_range) {
      weekly.estimated_co2e_kg_range[0] += s.co2e_kg_range[0];
      weekly.estimated_co2e_kg_range[1] += s.co2e_kg_range[1];
    }
  }

  // Round for readability.
  weekly.reagent_volume_saved_ml = round1(weekly.reagent_volume_saved_ml);
  weekly.estimated_co2e_kg_range = [
    round2(weekly.estimated_co2e_kg_range[0]),
    round2(weekly.estimated_co2e_kg_range[1]),
  ];

  // Naive ×52 projection. The README acknowledges this is rough.
  const annualized: ImpactWeekly = {
    reagent_volume_saved_ml: round1(weekly.reagent_volume_saved_ml * 52),
    hazardous_disposal_events_avoided:
      weekly.hazardous_disposal_events_avoided * 52,
    estimated_co2e_kg_range: [
      round2(weekly.estimated_co2e_kg_range[0] * 52),
      round2(weekly.estimated_co2e_kg_range[1] * 52),
    ],
    prep_events_saved: weekly.prep_events_saved * 52,
    equipment_runs_saved: weekly.equipment_runs_saved * 52,
  };

  return { weekly, annualized_if_repeated: annualized };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
