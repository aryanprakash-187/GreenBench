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
import { narrateWeekPlan } from '@/lib/llm/narrate';
import type { EnginePlanInput, EnrichedProtocol, HydratedTask } from '@/lib/engine/types';

export const runtime = 'nodejs';

interface IncomingTask {
  task_id?: string;
  protocol: EnrichedProtocol;
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
            if (!t.protocol || typeof t.protocol !== 'object') {
              throw new EngineError(
                `people[${pi}].tasks[${ti}] is missing a hydrated protocol.`,
                'TASK_NO_PROTOCOL'
              );
            }
            return {
              task_id:
                t.task_id ??
                synthTaskId(p.name!, t.protocol.protocol_name, ti),
              protocol: t.protocol,
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

function synthTaskId(person: string, protocolName: string, idx: number): string {
  // 0-based idx to match array indices and the frontend's synthTaskId in
  // components/HomeForm.tsx (the two used to disagree, which would silently
  // collide if the backend ever had to synthesize an id for a task the
  // frontend already named).
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug(person)}__${slug(protocolName)}__${idx}`;
}
