// Deterministic engine entry point.
//
// planWeek(input) is the single function the API route (or a test fixture)
// calls. Everything inside is pure synchronous TypeScript: matcher,
// scheduler, compatibility, impact. No LLM, no fs (data layer is already
// memoized after the first hydration), no network.
//
// The narrator (Layer 4) consumes WeekPlanResult separately and replaces the
// engine's placeholder `recommendation` strings with prose.

import {
  buildEquipmentCoordinations,
  buildReagentCoordinations,
} from './matcher';
import { buildSeparations } from './compatibility';
import { scheduleWeek } from './scheduler';
import { rollupImpact } from './impact';
import type { EnginePlanInput, WeekPlanResult } from './types';

export class EngineError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export function planWeek(input: EnginePlanInput): WeekPlanResult {
  validateInput(input);

  const peopleView = input.people.map((p) => ({
    name: p.name,
    tasks: p.tasks,
  }));

  // 1. Coordination candidates (pure data inspection — no scheduling yet).
  const reagentCoords = buildReagentCoordinations(peopleView);
  const equipmentCoords = buildEquipmentCoordinations(peopleView);
  const coordinations = [...reagentCoords, ...equipmentCoords];

  // 2. Separations (pure pairwise rules).
  const separations = buildSeparations(peopleView);

  // 3. Scheduler — places tasks, mutates coordinations.aligned, populates
  //    schedule[].shared_with / notes.
  const { schedule, diagnostics } = scheduleWeek(
    input.week_start_iso,
    input.people,
    coordinations
  );

  // 4. Impact rollup — uses savings from coordinations regardless of
  //    alignment. (The README says we still surface the saving as advisory
  //    even when the scheduler couldn't align participants.)
  const impact = rollupImpact(coordinations);

  return {
    week_start_iso: input.week_start_iso,
    schedule,
    coordinations,
    separations,
    impact,
    diagnostics,
  };
}

function validateInput(input: EnginePlanInput): void {
  if (!input.week_start_iso) {
    throw new EngineError('week_start_iso is required.', 'MISSING_WEEK_START');
  }
  const ws = new Date(input.week_start_iso);
  if (Number.isNaN(ws.getTime())) {
    throw new EngineError(
      `week_start_iso is not a valid ISO timestamp: ${input.week_start_iso}`,
      'BAD_WEEK_START'
    );
  }
  if (!Array.isArray(input.people) || input.people.length === 0) {
    throw new EngineError('At least one person is required.', 'NO_PEOPLE');
  }
  for (const p of input.people) {
    if (!p.name || !p.name.trim()) {
      throw new EngineError('Every person must have a non-empty name.', 'PERSON_NO_NAME');
    }
    if (!Array.isArray(p.tasks) || p.tasks.length === 0) {
      throw new EngineError(
        `Person "${p.name}" has no tasks.`,
        'PERSON_NO_TASKS'
      );
    }
    const seen = new Set<string>();
    for (const t of p.tasks) {
      if (!t.task_id) {
        throw new EngineError(
          `Person "${p.name}" has a task with no task_id.`,
          'TASK_NO_ID'
        );
      }
      if (seen.has(t.task_id)) {
        throw new EngineError(
          `Duplicate task_id "${t.task_id}" within person "${p.name}".`,
          'DUPLICATE_TASK_ID'
        );
      }
      seen.add(t.task_id);
    }
  }
}

export type { WeekPlanResult, EnginePlanInput } from './types';
