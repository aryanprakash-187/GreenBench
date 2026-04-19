import type {
  EnrichedProtocol,
  NarratedWeekPlanResult,
} from "@/lib/engine/types";

/* ---------- Legacy stub types (preserved for backwards compatibility) ---------- */

export type FileStub = { name: string; size: number } | null;

export type PersonStub = {
  name: string;
  protocol: FileStub;
  schedule: FileStub;
  sampleCount: string;
};

/* ---------- Rich per-person + per-protocol records ---------- */

export type SubmissionProtocolInput = {
  filename: string;
  size: number;
  sample_count: number;
  task_id: string;
  matched_protocol_name: string;
  matched_via: string;
  match_confidence: number;
  enriched: EnrichedProtocol;
};

export type SubmissionPersonInput = {
  name: string;
  schedule_filename: string | null;
  schedule_size: number | null;
  /** Raw .ics text the user uploaded — preserved verbatim so the exporter
   *  can pass original VEVENTs through unchanged. May be null when the user
   *  didn't upload a calendar. */
  schedule_ics_text: string | null;
  protocols: SubmissionProtocolInput[];
};

/* ---------- Top-level submission ----------
 *
 * The shape persists in localStorage under key `greenbench.submission`. It
 * carries everything OverviewPage / SchedulesPage need to render a fully
 * data-driven plan and exports — no mocks. The legacy `people` field (with
 * FileStubs) is kept too so older code paths continue to read names.
 */

export type Submission = {
  submittedAt: string;
  /** Legacy mirror — list of {name, protocol, schedule, sampleCount} stubs.
   *  Kept so existing callers of namesList()/loadSubmission() keep working. */
  people: PersonStub[];
  /** Rich per-person input echoed back from /api/match (parsed protocols,
   *  ICS text, etc.). Optional so old localStorage payloads still load. */
  inputs?: SubmissionPersonInput[];
  /** Final NarratedWeekPlanResult from /api/plan?narrate=1. Optional so older
   *  payloads (or aborted submissions) still load — UI must guard. */
  plan?: NarratedWeekPlanResult;
};

export const SUBMISSION_STORAGE_KEY = "greenbench.submission";

export function loadSubmission(): Submission | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SUBMISSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Submission;
  } catch {
    return null;
  }
}

export function saveSubmission(sub: Submission): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SUBMISSION_STORAGE_KEY, JSON.stringify(sub));
}

export function clearSubmission(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SUBMISSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function namesList(sub: Submission | null): string[] {
  return (
    sub?.people
      ?.map((p) => p.name)
      .filter((n): n is string => !!n && n.trim().length > 0) ?? []
  );
}

/** True iff the submission carries a fully-resolved plan from the engine. */
export function hasPlan(
  sub: Submission | null,
): sub is Submission & { plan: NarratedWeekPlanResult } {
  return !!sub && !!sub.plan && Array.isArray(sub.plan.schedule);
}
