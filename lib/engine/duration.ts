// Estimate wall-clock duration for a hydrated task.
//
// The seed CSVs do not carry per-protocol durations — adding a sheet for that
// would be data-team work we don't have time for. Instead we use a defensible
// heuristic per workflow family, with PCR computed exactly from the protocol's
// thermal profile.
//
// Numbers come from typical bench timing for the seeded protocols (DNeasy
// manual ~90 min hands-on for 8 samples; AMPure XP cleanup ~45 min for 12;
// PCR walk-time = sum of the thermal profile + 15 min setup/teardown).
//
// Sample-count scaling is intentionally weak: doubling samples doesn't double
// the bench time because the bottleneck steps (incubation, spin, magnet) are
// step-time-bound, not sample-bound. We add ~1 min per extra sample over the
// vendor default.

import type { EnrichedProtocol } from './types';

interface FamilyBaseline {
  base_min: number;
  default_samples: number;
  per_extra_sample_min: number;
}

const FAMILY_BASELINES: Record<string, FamilyBaseline> = {
  DNA_extraction: { base_min: 90, default_samples: 8, per_extra_sample_min: 1.5 },
  Bead_cleanup: { base_min: 45, default_samples: 12, per_extra_sample_min: 0.5 },
  // PCR is overwritten by thermal-profile math below; this is the fallback
  // when a protocol is mis-tagged with no profile.
  PCR: { base_min: 60, default_samples: 12, per_extra_sample_min: 0.25 },
};

const PCR_SETUP_MIN = 15;

/** Returns the modeled duration in minutes for one task. */
export function estimateTaskDurationMin(protocol: EnrichedProtocol): number {
  if (protocol.family === 'PCR' && protocol.thermal_profile) {
    const t = protocol.thermal_profile;
    const totalSeconds =
      t.initial_denature_time_s +
      t.cycles *
        (t.cycle_denature_time_s + t.annealing_time_s + t.extension_time_s) +
      t.final_extension_time_s;
    return Math.round(totalSeconds / 60 + PCR_SETUP_MIN);
  }

  const baseline = FAMILY_BASELINES[protocol.family] ?? FAMILY_BASELINES.PCR;
  const extra = Math.max(0, protocol.sample_count - baseline.default_samples);
  return Math.round(baseline.base_min + extra * baseline.per_extra_sample_min);
}
