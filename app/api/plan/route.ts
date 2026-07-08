// POST /api/plan
//
// Runs the deterministic engine. Caller is expected to have already hydrated
// each person's task(s) via /api/hydrate or /api/match. ICS calendars are
// passed as raw text and parsed inline.
//
// Body shape:
//   {
//     week_start_iso?: string,                     // optional; defaults to next Monday local
//     people: [
//       {
//         name: string,
//         operator_id?: string,
//         busy_ics_text?: string,                  // raw .ics file contents
//         tasks: [
//           {
//             task_id?: string,                    // synthesized if absent
//             protocol: EnrichedProtocol,          // from /api/hydrate
//           }, ...
//         ]
//       }, ...
//     ]
//   }
//
// Query params:
//   ?narrate=1       run the LLM narrator (Layer 4) and return a
//                    NarratedWeekPlanResult instead of the bare WeekPlanResult.
//                    The UI's preferred path — saves an extra round trip.
//
// Returns the WeekPlanResult or NarratedWeekPlanResult JSON.

import { NextRequest, NextResponse } from 'next/server';

import { EngineError, planWeek } from '@/lib/engine';
import { nextMondayLocalIso, parseIcsToBusy } from '@/lib/engine/ics';
import { resolveDraft, ResolveDraftError } from '@/lib/engine/resolveDraft';
import { narrateWeekPlan } from '@/lib/llm/narrate';
import type {
  DraftProtocol,
  EnginePlanInput,
  EnrichedProtocol,
  HydratedTask,
  ReagentConfirmation,
} from '@/lib/engine/types';

export const runtime = 'nodejs';

interface IncomingTask {
  task_id?: string;
  /** Pre-hydrated protocol from the legacy /api/match flow. */
  protocol?: EnrichedProtocol;
  /** LLM-extracted draft from /api/parse. When set, the route runs
   *  resolveDraft() on the fly to produce the EnrichedProtocol the engine
   *  consumes. Mutually exclusive with `protocol`. */
  draft?: DraftProtocol;
  /** User-confirmed overlap groups for each reagent in `draft`. */
  confirmations?: ReagentConfirmation[];
  /** Sample count when going through the draft path. Required when
   *  `draft` is set. */
  sample_count?: number;
}

interface IncomingPerson {
  name?: string;
  operator_id?: string;
  busy_ics_text?: string;
  tasks?: IncomingTask[];
}

interface IncomingBody {
  week_start_iso?: string;
  people?: IncomingPerson[];
}

export async function POST(req: NextRequest) {
  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  if (!body.people || !Array.isArray(body.people) || body.people.length === 0) {
    return NextResponse.json(
      { error: '"people" must be a non-empty array.' },
      { status: 400 }
    );
  }

  const weekStartIso = body.week_start_iso ?? nextMondayLocalIso();

  let input: EnginePlanInput;
  try {
    input = {
      week_start_iso: weekStartIso,
      people: body.people.map((p, pi) => {
        if (!p.name || !p.name.trim()) {
          throw new EngineError(
            `people[${pi}] has no name.`,
            'PERSON_NO_NAME'
          );
        }
        if (!p.tasks || p.tasks.length === 0) {
          throw new EngineError(
            `people[${pi}] (${p.name}) has no tasks.`,
            'PERSON_NO_TASKS'
          );
        }
        return {
          name: p.name.trim(),
          operator_id: p.operator_id,
          busy: p.busy_ics_text
            ? parseIcsToBusy(p.busy_ics_text, weekStartIso)
            : [],
          tasks: p.tasks.map((t, ti): HydratedTask => {
            const protocol = materializeProtocol(t, pi, ti);
            return {
              task_id:
                t.task_id ??
                synthTaskId(p.name!, protocol.protocol_name, ti),
              protocol,
            };
          }),
        };
      }),
    };
  } catch (err) {
    if (err instanceof EngineError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? 'Bad request' },
      { status: 400 }
    );
  }

  try {
    const result = planWeek(input);

    // Optional Layer 4: chain into the narrator if ?narrate=1.
    const url = new URL(req.url);
    const wantsNarration = url.searchParams.get('narrate') === '1';
    if (wantsNarration) {
      const disableLlm = url.searchParams.get('disable_llm') === '1';
      const narrated = await narrateWeekPlan(result, { disable_llm: disableLlm });
      return NextResponse.json(narrated, { status: 200 });
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof EngineError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 422 }
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? 'Engine error' },
      { status: 500 }
    );
  }
}

/** Turn an IncomingTask (either pre-hydrated `protocol` or LLM `draft` +
 *  confirmations) into the EnrichedProtocol the engine consumes. Throws an
 *  EngineError on bad input so the route returns 400 rather than 500. */
function materializeProtocol(
  task: IncomingTask,
  pi: number,
  ti: number
): EnrichedProtocol {
  if (task.protocol && task.draft) {
    throw new EngineError(
      `people[${pi}].tasks[${ti}] specified both "protocol" and "draft" — pick one.`,
      'TASK_AMBIGUOUS_INPUT'
    );
  }

  if (task.protocol && typeof task.protocol === 'object') {
    return task.protocol;
  }

  if (task.draft && typeof task.draft === 'object') {
    const sampleCount =
      typeof task.sample_count === 'number' && Number.isFinite(task.sample_count)
        ? task.sample_count
        : 0;
    if (sampleCount <= 0) {
      throw new EngineError(
        `people[${pi}].tasks[${ti}] uses a draft but is missing a positive sample_count.`,
        'TASK_NO_SAMPLE_COUNT'
      );
    }
    try {
      return resolveDraft({
        draft: task.draft,
        confirmations: task.confirmations ?? [],
        sample_count: sampleCount,
      });
    } catch (err) {
      if (err instanceof ResolveDraftError) {
        throw new EngineError(
          `people[${pi}].tasks[${ti}]: ${err.message}`,
          err.code
        );
      }
      throw err;
    }
  }

  throw new EngineError(
    `people[${pi}].tasks[${ti}] is missing both "protocol" and "draft".`,
    'TASK_NO_PROTOCOL'
  );
}

function synthTaskId(person: string, protocolName: string, idx: number): string {
  // 0-based idx to match array indices and the frontend's synthTaskId in
  // components/HomeForm.tsx (the two used to disagree, which would silently
  // collide if the backend ever had to synthesize an id for a task the
  // frontend already named).
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug(person)}__${slug(protocolName)}__${idx}`;
}
