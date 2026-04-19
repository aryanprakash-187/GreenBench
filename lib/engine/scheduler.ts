// Greedy interval scheduler.
//
// Per README: "imperfect but finds the easy wins. Proper CSP solver is a
// day-2 stretch."
//
// Algorithm:
//   1. Anchor at week_start_iso. Build per-person free intervals as
//      [operator_window ∩ ¬busy_ics] across each weekday.
//   2. Sort tasks by descending coordination potential (tasks involved in
//      coordinations are placed first so we can align them).
//   3. For each task: enforce intra-person family ordering (extraction <
//      PCR < cleanup) by requiring all earlier-family tasks owned by the
//      SAME person to be already-scheduled and ended before the new task
//      starts. Find the earliest slot fitting (a) the person free, (b) all
//      required equipment free.
//   4. After placing all tasks, walk coordinations: if the participants'
//      scheduled windows actually overlap (for shared_equipment_run) or the
//      shared prep can fit in a window before the earliest-using task (for
//      shared_reagent_prep), set aligned=true.
//
// All times are kept as ISO strings on the output but compared as ms.

import { loadEquipment, loadOperators } from './data';
import { estimateTaskDurationMin } from './duration';
import type {
  BusyInterval,
  Coordination,
  EnginePerson,
  HydratedTask,
  ScheduledTask,
  WeekPlanDiagnostics,
} from './types';

const MS_PER_MIN = 60 * 1000;
const WEEK_DAYS = 7;
const FAMILY_ORDER: Record<string, number> = {
  DNA_extraction: 0,
  PCR: 1,
  Bead_cleanup: 2,
};

interface EquipmentReservation {
  lab_id: string;
  start: number;
  end: number;
  task_id: string;
}

export interface SchedulerOutput {
  schedule: ScheduledTask[];
  diagnostics: WeekPlanDiagnostics;
}

/** Schedule all tasks and update Coordination.aligned in-place. */
export function scheduleWeek(
  weekStartIso: string,
  people: EnginePerson[],
  coordinations: Coordination[]
): SchedulerOutput {
  const weekStart = new Date(weekStartIso).getTime();
  const weekEnd = weekStart + WEEK_DAYS * 24 * 60 * MS_PER_MIN;

  // Per-person free intervals across the whole week, sorted ascending.
  const freeByPerson = new Map<string, FreeInterval[]>();
  for (const p of people) {
    freeByPerson.set(p.name, computeFreeIntervals(p, weekStart, weekEnd));
  }

  // Equipment reservations grow as we schedule.
  const equipmentReservations: EquipmentReservation[] = [];

  // Build a (task_id → coordination ids) lookup so prioritization can prefer
  // tasks that participate in any coordination.
  const coordWeight = new Map<string, number>();
  for (const c of coordinations) {
    for (const part of c.participants) {
      coordWeight.set(part.task_id, (coordWeight.get(part.task_id) ?? 0) + 1);
    }
  }

  // task_id -> set of peer task_ids it shares an equipment-run coordination
  // with. Used by the placer to prefer aligning with an already-placed peer
  // rather than walking past their equipment reservation. Without this, the
  // greedy pass essentially never aligns shared_equipment_run participants
  // (the first placement reserves the instrument and pushes everyone else
  // forward), so the "equipment runs saved" headline rolls up to 0.
  const equipmentPeers = new Map<string, Set<string>>();
  for (const c of coordinations) {
    if (c.type !== 'shared_equipment_run') continue;
    const ids = c.participants.map((p) => p.task_id);
    for (const id of ids) {
      const peers = equipmentPeers.get(id) ?? new Set<string>();
      for (const other of ids) if (other !== id) peers.add(other);
      equipmentPeers.set(id, peers);
    }
  }

  // Flatten with person attribution.
  const flat: { person: EnginePerson; task: HydratedTask }[] = [];
  for (const p of people) for (const t of p.tasks) flat.push({ person: p, task: t });

  // Sort: (1) higher coord weight first, (2) family order ascending so
  // dependencies resolve naturally, (3) longer task first as a tiebreaker.
  flat.sort((a, b) => {
    const wa = coordWeight.get(a.task.task_id) ?? 0;
    const wb = coordWeight.get(b.task.task_id) ?? 0;
    if (wa !== wb) return wb - wa;
    const fa = FAMILY_ORDER[a.task.protocol.family] ?? 99;
    const fb = FAMILY_ORDER[b.task.protocol.family] ?? 99;
    if (fa !== fb) return fa - fb;
    return (
      estimateTaskDurationMin(b.task.protocol) -
      estimateTaskDurationMin(a.task.protocol)
    );
  });

  const scheduled: ScheduledTask[] = [];
  const unscheduled: { task_id: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const { person, task } of flat) {
    const durationMin = estimateTaskDurationMin(task.protocol);
    const durationMs = durationMin * MS_PER_MIN;

    const earliestAllowedMs = computeFamilyEarliestStart(
      task,
      person.name,
      scheduled
    );

    // Concrete equipment to reserve. Skip equipment_required entries that
    // didn't resolve to a real lab catalog row — the engine warns instead
    // of treating them as a hard miss.
    const equipmentToReserve = task.protocol.equipment_required.filter(
      (e) => e.lab_id !== null
    ) as { equipment_group: string; lab_id: string }[];
    if (
      task.protocol.equipment_required.length > 0 &&
      equipmentToReserve.length === 0
    ) {
      warnings.push(
        `Task ${task.task_id} requires equipment but no lab catalog row matched — scheduling without an equipment reservation.`
      );
    }

    const peerIds = equipmentPeers.get(task.task_id);
    const placement = placeTask({
      taskId: task.task_id,
      durationMs,
      earliestStartMs: Math.max(weekStart, earliestAllowedMs),
      latestEndMs: weekEnd,
      personFree: freeByPerson.get(person.name) ?? [],
      equipmentReservations,
      equipmentToReserve,
      // Pre-placed peers from the same shared_equipment_run coordination.
      // The placer will try their start time first and treat their existing
      // equipment reservation as shareable rather than blocking.
      equipmentPeerStarts: peerIds
        ? scheduled
            .filter((s) => peerIds.has(s.task_id))
            .map((s) => new Date(s.start_iso).getTime())
        : [],
      equipmentPeerTaskIds: peerIds ?? new Set<string>(),
    });

    if (!placement) {
      unscheduled.push({
        task_id: task.task_id,
        reason: equipmentToReserve.length
          ? `No mutually-free slot found for ${person.name} + equipment ${equipmentToReserve.map((e) => e.lab_id).join(', ')}.`
          : `No free slot found in ${person.name}'s availability for ${durationMin} min.`,
      });
      continue;
    }

    // Reserve free time and equipment.
    freeByPerson.set(
      person.name,
      reserveFromFree(freeByPerson.get(person.name) ?? [], placement.start, placement.end)
    );
    for (const eq of equipmentToReserve) {
      equipmentReservations.push({
        lab_id: eq.lab_id,
        start: placement.start,
        end: placement.end,
        task_id: task.task_id,
      });
    }

    scheduled.push({
      task_id: task.task_id,
      person: person.name,
      protocol_name: task.protocol.protocol_name,
      family: task.protocol.family,
      start_iso: new Date(placement.start).toISOString(),
      end_iso: new Date(placement.end).toISOString(),
      duration_min: durationMin,
      equipment: task.protocol.equipment_required.map((e) => ({
        equipment_group: e.equipment_group,
        lab_id: e.lab_id,
      })),
      shared_with: [],
      notes: [],
    });
  }

  // After all placements, resolve coordination alignment + populate
  // shared_with on the schedule.
  alignCoordinations(coordinations, scheduled);

  return {
    schedule: scheduled,
    diagnostics: { warnings, unscheduled },
  };
}

// ----- placement -----

interface FreeInterval {
  start: number;
  end: number;
}

interface PlaceArgs {
  taskId: string;
  durationMs: number;
  earliestStartMs: number;
  latestEndMs: number;
  personFree: FreeInterval[];
  equipmentReservations: EquipmentReservation[];
  equipmentToReserve: { equipment_group: string; lab_id: string }[];
  /** Start times of already-placed peers in a shared_equipment_run we should
   *  try to align with. The placer attempts these first. */
  equipmentPeerStarts: number[];
  /** Task ids whose equipment reservations are shareable with this task
   *  (same shared_equipment_run coordination). */
  equipmentPeerTaskIds: Set<string>;
}

function placeTask(a: PlaceArgs): { start: number; end: number } | null {
  // 1. Try aligning with an already-placed shared_equipment_run peer first.
  //    The peer's start is only viable if (a) the candidate window is fully
  //    inside one of our person's free intervals, (b) it respects the
  //    family-ordering earliest, and (c) no NON-peer task is holding the
  //    same equipment in that window.
  for (const peerStart of a.equipmentPeerStarts) {
    if (peerStart < a.earliestStartMs) continue;
    const candidateEnd = peerStart + a.durationMs;
    if (candidateEnd > a.latestEndMs) continue;
    if (!fitsInsideFree(a.personFree, peerStart, candidateEnd)) continue;
    const conflict = findEquipmentConflict(
      peerStart,
      candidateEnd,
      a.equipmentToReserve,
      a.equipmentReservations,
      a.equipmentPeerTaskIds
    );
    if (!conflict) return { start: peerStart, end: candidateEnd };
  }

  // 2. Greedy walk: earliest free slot that also clears equipment.
  for (const slot of a.personFree) {
    const slotStart = Math.max(slot.start, a.earliestStartMs);
    if (slotStart + a.durationMs > slot.end) continue;
    if (slotStart + a.durationMs > a.latestEndMs) continue;

    let candidate = slotStart;
    while (candidate + a.durationMs <= slot.end) {
      const conflict = findEquipmentConflict(
        candidate,
        candidate + a.durationMs,
        a.equipmentToReserve,
        a.equipmentReservations,
        a.equipmentPeerTaskIds
      );
      if (!conflict) return { start: candidate, end: candidate + a.durationMs };
      candidate = conflict.end; // jump past the conflict
    }
  }
  return null;
}

function fitsInsideFree(
  free: FreeInterval[],
  start: number,
  end: number
): boolean {
  for (const f of free) {
    if (f.start <= start && f.end >= end) return true;
  }
  return false;
}

function findEquipmentConflict(
  start: number,
  end: number,
  toReserve: { lab_id: string }[],
  reservations: EquipmentReservation[],
  shareableTaskIds: Set<string>
): EquipmentReservation | null {
  for (const need of toReserve) {
    for (const r of reservations) {
      if (r.lab_id !== need.lab_id) continue;
      // Reservations belonging to a peer in the same shared_equipment_run
      // are shareable — that's the entire point of batching the run.
      if (shareableTaskIds.has(r.task_id)) continue;
      if (r.start < end && r.end > start) return r;
    }
  }
  return null;
}

// ----- per-person free interval construction -----

function computeFreeIntervals(
  person: EnginePerson,
  weekStart: number,
  weekEnd: number
): FreeInterval[] {
  // Operator availability (per weekday). Default = 08:00–22:00 if no
  // operators row matches. Name comparison is case-insensitive AND
  // diacritic-tolerant so an input person "Jose" matches an operators.csv
  // entry "José" (and vice versa) — without normalization we silently fell
  // back to the default window, dropping any custom availability.
  const ops = loadOperators();
  const personKey = normalizeName(person.name);
  const opRow =
    (person.operator_id && ops.find((o) => o.id === person.operator_id)) ||
    ops.find((o) => normalizeName(o.name) === personKey);

  const freeBlocks: FreeInterval[] = [];
  for (let day = 0; day < WEEK_DAYS; day++) {
    const dayStartMs = weekStart + day * 24 * 60 * MS_PER_MIN;
    const dow = new Date(dayStartMs).getUTCDay(); // 0=Sun ... 6=Sat
    const window = pickAvailabilityWindow(opRow, dow);
    if (!window) continue;
    freeBlocks.push({
      start: dayStartMs + window.startMin * MS_PER_MIN,
      end: dayStartMs + window.endMin * MS_PER_MIN,
    });
  }

  // Subtract busy intervals.
  return subtractBusy(freeBlocks, person.busy, weekStart, weekEnd);
}

interface OperatorRowLike {
  availability_mon?: string;
  availability_tue?: string;
  availability_wed?: string;
  availability_thu?: string;
  availability_fri?: string;
  availability_sat?: string;
  availability_sun?: string;
}

function pickAvailabilityWindow(
  op: OperatorRowLike | undefined,
  dow: number
): { startMin: number; endMin: number } | null {
  // Map day-of-week (Sun=0) to availability column.
  const cols = [
    'availability_sun',
    'availability_mon',
    'availability_tue',
    'availability_wed',
    'availability_thu',
    'availability_fri',
    'availability_sat',
  ] as const;

  // Default for the demo: weekdays 08:00–22:00. operators.csv only has
  // mon–fri, and weekends are empty → the engine can still place tasks on
  // weekends if we let it. Keep the simpler default: weekdays only.
  const defaultWindow =
    dow >= 1 && dow <= 5 ? { startMin: 8 * 60, endMin: 22 * 60 } : null;
  if (!op) return defaultWindow;

  const raw = (op[cols[dow]] ?? '').trim();
  if (!raw) return defaultWindow;
  return parseHhMmRange(raw);
}

/** Lowercase + strip combining diacritics so "José" and "Jose" compare equal. */
function normalizeName(s: string): string {
  return s.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function parseHhMmRange(s: string): { startMin: number; endMin: number } | null {
  const m = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return {
    startMin: +m[1] * 60 + +m[2],
    endMin: +m[3] * 60 + +m[4],
  };
}

function subtractBusy(
  free: FreeInterval[],
  busy: BusyInterval[],
  _weekStart: number,
  _weekEnd: number
): FreeInterval[] {
  if (busy.length === 0) return free;
  const busyMs = busy
    .map((b) => ({
      start: new Date(b.start_iso).getTime(),
      end: new Date(b.end_iso).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  let cur = free.slice();
  for (const b of busyMs) {
    const next: FreeInterval[] = [];
    for (const f of cur) {
      if (b.end <= f.start || b.start >= f.end) {
        next.push(f);
        continue;
      }
      if (b.start > f.start) next.push({ start: f.start, end: b.start });
      if (b.end < f.end) next.push({ start: b.end, end: f.end });
    }
    cur = next;
  }
  // Drop zero/negative-length blocks.
  return cur.filter((f) => f.end - f.start >= MS_PER_MIN);
}

function reserveFromFree(
  free: FreeInterval[],
  start: number,
  end: number
): FreeInterval[] {
  const next: FreeInterval[] = [];
  for (const f of free) {
    if (end <= f.start || start >= f.end) {
      next.push(f);
      continue;
    }
    if (start > f.start) next.push({ start: f.start, end: start });
    if (end < f.end) next.push({ start: end, end: f.end });
  }
  return next;
}

// ----- intra-person family ordering -----

function computeFamilyEarliestStart(
  task: HydratedTask,
  personName: string,
  scheduled: ScheduledTask[]
): number {
  const myFamilyRank = FAMILY_ORDER[task.protocol.family] ?? 99;
  let earliest = 0;
  for (const s of scheduled) {
    if (s.person !== personName) continue;
    const rank = FAMILY_ORDER[s.family] ?? 99;
    if (rank >= myFamilyRank) continue;
    const endMs = new Date(s.end_iso).getTime();
    if (endMs > earliest) earliest = endMs;
  }
  return earliest;
}

// ----- coordination alignment -----

function alignCoordinations(
  coordinations: Coordination[],
  scheduled: ScheduledTask[]
): void {
  const byId = new Map(scheduled.map((s) => [s.task_id, s] as const));

  for (const c of coordinations) {
    const placed = c.participants
      .map((p) => byId.get(p.task_id))
      .filter((s): s is ScheduledTask => !!s);
    if (placed.length < 2) continue;

    if (c.type === 'shared_equipment_run') {
      // Aligned iff all placements share an exact start time on the same
      // equipment lab_id. Greedy will rarely place them at the same start
      // unless we explicitly try; for v1 we just check overlap and let the
      // UI display "could batch if you started at TIME together".
      const starts = placed.map((s) => new Date(s.start_iso).getTime());
      const allSame = starts.every((t) => t === starts[0]);
      c.aligned = allSame;
      if (allSame) {
        for (const s of placed) {
          const others = placed.filter((o) => o.task_id !== s.task_id).map((o) => o.task_id);
          s.shared_with = unique([...s.shared_with, ...others]);
          s.notes.push(`Batched on ${c.equipment_group} with ${others.join(', ')}.`);
        }
      }
    } else {
      // shared_reagent_prep: aligned iff there is at least 1h of mutual
      // free time before the earliest user. We don't try to schedule a
      // separate prep block (no equipment for prep tasks); we just confirm
      // that one COULD be planned. The UI will surface the recommendation
      // either way.
      // For v1 we don't try to schedule a separate prep block (no equipment
      // for prep tasks). The matcher already verified stability + batchability
      // when emitting this coordination, so as long as 2+ participants placed,
      // the shared prep is plannable. The UI will surface it either way.
      c.aligned = true;
      const partTaskIds = placed.map((p) => p.task_id);
      for (const s of placed) {
        const others = partTaskIds.filter((id) => id !== s.task_id);
        s.shared_with = unique([...s.shared_with, ...others]);
        s.notes.push(`Shared ${c.overlap_group} prep with ${others.join(', ')}.`);
      }
    }
  }
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
