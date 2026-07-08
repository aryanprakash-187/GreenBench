// Deterministic "when does the shared prep actually happen" calculation.
//
// The scheduler (scheduler.ts) only ever places PROTOCOL TASKS — it has no
// concept of a standalone calendar event for a `shared_reagent_prep`
// coordination (e.g. "prep 40.6 mL of Buffer ATL once"). Three different UI
// surfaces independently want to show a user WHEN to actually do that prep:
// the calendar preview (components/SchedulesPage.tsx), the .ics export
// (lib/export/ics.ts), and the coordination recommendation cards
// (components/OverviewPage.tsx). This module is the single source of that
// math so all three can never disagree with each other.
//
// The rule: a prep block ends SHARED_PREP_LEAD_MIN minutes before the
// earliest participant task it feeds begins. If multiple preps anchor to
// that same moment (a person has several shared-prep coordinations feeding
// the same task start), they're staggered back-to-back
// (DEFAULT_DURATION_MIN + STAGGER_GAP_MIN apart) instead of stacked on top
// of each other — a single human can't prep three reagents simultaneously.

import type { NarratedCoordination, ScheduledTask } from './types';

export const SHARED_PREP_LEAD_MIN = 30;
export const SHARED_PREP_DEFAULT_DURATION_MIN = 20;
export const SHARED_PREP_STAGGER_GAP_MIN = 5;

export interface SharedPrepSlot {
  start: Date;
  end: Date;
}

/** Earliest scheduled-task start (in ms) across a coordination's
 *  participants, or null if none of them made it into the schedule. */
export function earliestParticipantStartMs(
  coord: NarratedCoordination,
  schedule: ScheduledTask[]
): number | null {
  const starts = coord.participants
    .map((p) => schedule.find((s) => s.task_id === p.task_id))
    .filter((s): s is ScheduledTask => !!s)
    .map((s) => new Date(s.start_iso).getTime());
  if (starts.length === 0) return null;
  return Math.min(...starts);
}

/** Computes the staged prep window for every `shared_reagent_prep`
 *  coordination in a plan, keyed by coordination id. A coordination is
 *  omitted if none of its participant tasks made it into the schedule
 *  (nothing to anchor the prep time to). Callers that only care about preps
 *  relevant to one person, or with nonzero savings, filter the input
 *  `coordinations` array (or the output map) themselves — this function
 *  doesn't know about "person" or "savings", only timing. */
export function computeSharedPrepSlots(
  coordinations: NarratedCoordination[],
  schedule: ScheduledTask[]
): Map<string, SharedPrepSlot> {
  const buckets = new Map<number, NarratedCoordination[]>();
  for (const coord of coordinations) {
    if (coord.type !== 'shared_reagent_prep') continue;
    const anchorMs = earliestParticipantStartMs(coord, schedule);
    if (anchorMs === null) continue;
    const list = buckets.get(anchorMs) ?? [];
    list.push(coord);
    buckets.set(anchorMs, list);
  }

  const out = new Map<string, SharedPrepSlot>();
  for (const [anchorMs, entries] of buckets) {
    // Stable order so the same plan always produces the same staggered
    // layout (deterministic exports/renders, diff-friendly tests).
    entries.sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < entries.length; i++) {
      const coord = entries[i];
      const startOffsetMin =
        SHARED_PREP_LEAD_MIN +
        SHARED_PREP_DEFAULT_DURATION_MIN +
        i * (SHARED_PREP_DEFAULT_DURATION_MIN + SHARED_PREP_STAGGER_GAP_MIN);
      const start = new Date(anchorMs - startOffsetMin * 60 * 1000);
      const end = new Date(
        start.getTime() + SHARED_PREP_DEFAULT_DURATION_MIN * 60 * 1000
      );
      out.set(coord.id, { start, end });
    }
  }
  return out;
}
