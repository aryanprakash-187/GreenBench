"use client";

import { useMemo, useRef, useState } from "react";
import { Footer } from "@/components/OverviewPage";
import ProtocolDraftReview from "@/components/ProtocolDraftReview";
import { nextMondayLocalIso } from "@/lib/engine/ics";
import {
  saveSubmission,
  type PersonStub,
  type Submission,
  type SubmissionPersonInput,
  type SubmissionProtocolInput,
} from "@/lib/submission";
import type {
  DraftProtocol,
  NarratedWeekPlanResult,
  ReagentConfirmation,
} from "@/lib/engine/types";

/** How many upcoming Mondays to offer in the week picker. Kept small — this
 *  is a demo/pilot tool for planning the near-term week, not a scheduling
 *  calendar. */
const WEEK_OPTIONS_COUNT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One selectable planning week: [iso, iso + 7d). `iso` is always a UTC
 *  midnight Monday (see `nextMondayLocalIso` in lib/engine/ics.ts — the
 *  engine anchors week math in UTC end-to-end to avoid the "server in
 *  CET/JST reports Monday but anchors Sunday UTC" bug documented there). */
export interface WeekOption {
  iso: string;
  label: string;
}

/** Build `count` consecutive Monday-start week options beginning with the
 *  next upcoming Monday (today included if today is Monday). Formats both
 *  ends with `timeZone: "UTC"` to match the display convention already used
 *  for `plan.week_start_iso` in OverviewPage.tsx — otherwise a browser west
 *  of UTC would render the Monday-00:00-UTC anchor as "Sunday". */
export function buildWeekOptions(count: number, now: Date = new Date()): WeekOption[] {
  const firstMondayIso = nextMondayLocalIso(now);
  const firstMonday = new Date(firstMondayIso);
  // Pin locale — `undefined` uses the runtime default, so Node (SSR) and the
  // browser can disagree (e.g. "Jul 13" vs "13 Jul") and trip a hydration error.
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const options: WeekOption[] = [];
  for (let i = 0; i < count; i++) {
    const start = new Date(firstMonday.getTime() + i * 7 * DAY_MS);
    const end = new Date(start.getTime() + 6 * DAY_MS);
    const yearSuffix = end.toLocaleDateString("en-US", {
      year: "numeric",
      timeZone: "UTC",
    });
    options.push({
      iso: start.toISOString(),
      label: `${fmt(start)} \u2013 ${fmt(end)}, ${yearSuffix}${
        i === 0 ? " (next week)" : ""
      }`,
    });
  }
  return options;
}

/** One protocol upload (PDF + its own sample count) inside a person's card.
 *  The engine already accepts multiple tasks per person (EnginePerson.tasks);
 *  this lets the UI collect more than one. */
export type ProtocolEntry = {
  protocol: File | null;
  sampleCount: string;
};

export type Person = {
  name: string;
  /** One calendar per person — shared across all their protocols. */
  schedule: File | null;
  /** One or more protocols this labmate is running that week. */
  protocols: ProtocolEntry[];
};

export const EMPTY_PROTOCOL: ProtocolEntry = {
  protocol: null,
  sampleCount: "",
};

export const EMPTY_PERSON: Person = {
  name: "",
  schedule: null,
  protocols: [{ ...EMPTY_PROTOCOL }],
};

export const MIN_PEOPLE = 1;
export const MAX_PEOPLE = 6;
export const MIN_PROTOCOLS = 1;
export const MAX_PROTOCOLS_PER_PERSON = 4;

/** A sequencing run has no PDF to read — the only load-bearing input is how
 *  many samples go through the machine. It skips /api/parse entirely (there
 *  is nothing to extract) and is turned into a fixed DraftProtocol template
 *  client-side; see `buildSequencingDraft` below.
 *
 *  It lives in its own card, separate from the labmate cards above, with its
 *  own name field and its own calendar upload. At submit time each row
 *  becomes its OWN entry in the `people[]` array sent to /api/plan — it is
 *  never folded into a labmate card, even when the name matches one.
 *
 *  DUPLICATE-NAME CAVEAT (by design, confirmed with the user — do not "fix"
 *  this by merging without re-confirming): if this row's name matches an
 *  existing labmate card, /api/plan receives TWO people entries with the
 *  same name. The engine's scheduler keys per-person availability by the
 *  name string (lib/engine/scheduler.ts's `freeByPerson` map), so whichever
 *  entry it processes LAST silently overwrites the earlier one's calendar —
 *  there is no merge and no warning. This is only safe because the intended
 *  usage is: upload that SAME person's SAME .ics calendar again in this row.
 *  If the two rows ever carry DIFFERENT calendars for the same name, the
 *  engine schedules against whichever one happened to be processed last and
 *  silently discards the other's busy times. See also the caveat on
 *  `SchedulesPage.tsx`'s `buildPersonRows`, which has the same "last one
 *  wins by name" shape for the exported-calendar preview. */
export type SequencingRun = {
  name: string;
  /** Required — see the duplicate-calendar caveat above. If this person
   *  already has a labmate card, upload their SAME .ics file here too. */
  schedule: File | null;
  sampleCount: string;
};

export const EMPTY_SEQUENCING_RUN: SequencingRun = {
  name: "",
  schedule: null,
  sampleCount: "",
};

export const MAX_SEQUENCING_RUNS = 8;

/** Fresh person with its own nested `protocols` array. Use this instead of
 *  spreading `EMPTY_PERSON` — a shallow `{ ...EMPTY_PERSON }` would alias the
 *  same protocols array across every labmate. */
export function makeEmptyPerson(): Person {
  return { name: "", schedule: null, protocols: [{ ...EMPTY_PROTOCOL }] };
}

type HomeFormProps = {
  people: Person[];
  setPeople: React.Dispatch<React.SetStateAction<Person[]>>;
  onSubmitted?: () => void;
};

type Stage =
  | { kind: "idle" }
  | { kind: "running"; label: string; sub?: string }
  | { kind: "error"; message: string }
  // After /api/parse fires for every (person × protocol), we drop into the
  // review state to walk them through confirming each draft. ParsedProtocol
  // carries everything the review modal + the eventual /api/plan call needs.
  | {
      kind: "review";
      parsed: ParsedProtocol[];
      /** Index of the parsed protocol currently showing the review modal. */
      cursor: number;
    };

interface ParsedProtocol {
  /** Index in the original `people` prop, so we can group protocols back
   *  under their owner with the right ordering. */
  personIndex: number;
  /** Index of this protocol within its owner's `protocols` array. */
  protocolIndex: number;
  /** Trimmed display name of the owning person. */
  name: string;
  /** Stable engine task id, synthesized once at parse time so the /api/plan
   *  request and the submission record reference the same id. */
  taskId: string;
  /** Sample count the user typed (already rounded by parsePositiveInt). */
  sampleCount: number;
  /** Original uploaded files preserved verbatim — needed for the
   *  submission record and for the engine's ICS busy intervals. */
  protocolFile: File;
  scheduleFile: File | null;
  scheduleText: string;
  /** /api/parse response: the LLM's extraction + the closed vocabulary. */
  draft: DraftProtocol;
  allowedOverlapGroups: string[];
  /** Populated by the review modal when the user clicks "Confirm". */
  confirmations: ReagentConfirmation[] | null;
}

export default function HomeForm({
  people,
  setPeople,
  onSubmitted,
}: HomeFormProps) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const submitting = stage.kind === "running" || stage.kind === "review";

  // Which week to plan. Defaults to the next upcoming Monday, same default
  // /api/plan falls back to server-side (nextMondayLocalIso()) when
  // week_start_iso is omitted — the picker just makes that choice explicit
  // and lets the user pick a different upcoming week.
  const weekOptions = useMemo(() => buildWeekOptions(WEEK_OPTIONS_COUNT), []);
  const [weekStartIso, setWeekStartIso] = useState<string>(
    () => weekOptions[0].iso,
  );

  // Sequencing runs live in their own section, independent of the labmate
  // cards above. Empty by default — most weeks have none.
  const [sequencingRuns, setSequencingRuns] = useState<SequencingRun[]>([]);

  function addSequencingRun() {
    setSequencingRuns((prev) =>
      prev.length >= MAX_SEQUENCING_RUNS
        ? prev
        : [...prev, { ...EMPTY_SEQUENCING_RUN }],
    );
  }

  function updateSequencingRun(index: number, patch: Partial<SequencingRun>) {
    setSequencingRuns((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function removeSequencingRun(index: number) {
    setSequencingRuns((prev) => prev.filter((_, i) => i !== index));
  }

  function updatePerson(index: number, patch: Partial<Person>) {
    setPeople((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function addPerson() {
    setPeople((prev) =>
      prev.length >= MAX_PEOPLE ? prev : [...prev, makeEmptyPerson()],
    );
  }

  function removePerson(index: number) {
    setPeople((prev) =>
      prev.length <= MIN_PEOPLE ? prev : prev.filter((_, i) => i !== index),
    );
  }

  function updateProtocol(
    personIndex: number,
    protocolIndex: number,
    patch: Partial<ProtocolEntry>,
  ) {
    setPeople((prev) => {
      const next = [...prev];
      const person = next[personIndex];
      const protocols = person.protocols.map((pr, i) =>
        i === protocolIndex ? { ...pr, ...patch } : pr,
      );
      next[personIndex] = { ...person, protocols };
      return next;
    });
  }

  function addProtocol(personIndex: number) {
    setPeople((prev) => {
      const next = [...prev];
      const person = next[personIndex];
      if (person.protocols.length >= MAX_PROTOCOLS_PER_PERSON) return prev;
      next[personIndex] = {
        ...person,
        protocols: [...person.protocols, { ...EMPTY_PROTOCOL }],
      };
      return next;
    });
  }

  function removeProtocol(personIndex: number, protocolIndex: number) {
    setPeople((prev) => {
      const next = [...prev];
      const person = next[personIndex];
      if (person.protocols.length <= MIN_PROTOCOLS) return prev;
      next[personIndex] = {
        ...person,
        protocols: person.protocols.filter((_, i) => i !== protocolIndex),
      };
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    try {
      // 1. Read calendar files (.ics) into text up front (one per person).
      setStage({ kind: "running", label: "Reading calendar files…" });
      const scheduleTexts = await Promise.all(
        people.map((p) => (p.schedule ? p.schedule.text() : Promise.resolve(""))),
      );

      // 2. For each person × protocol, hit /api/parse to get a draft. The
      //    user then confirms the parsed reagents in a review modal before
      //    we send anything to /api/plan.
      const parsedList: ParsedProtocol[] = [];
      const total = people.reduce(
        (acc, p) => acc + p.protocols.filter((pr) => pr.protocol).length,
        0,
      );
      let done = 0;
      // Global running id so every (person × protocol) task is unique even
      // when one person uploads several protocols.
      let taskCounter = 0;

      for (let pi = 0; pi < people.length; pi++) {
        const person = people[pi];
        const personName = person.name.trim();

        for (let pr = 0; pr < person.protocols.length; pr++) {
          const entry = person.protocols[pr];
          if (!entry.protocol) continue;

          const samples = parsePositiveInt(entry.sampleCount, 8);

          done += 1;
          setStage({
            kind: "running",
            label: "Reading protocols",
            sub: `(${done}/${total}) ${personName} · ${entry.protocol.name}`,
          });

          const fd = new FormData();
          fd.append("file", entry.protocol);

          const res = await fetch("/api/parse", { method: "POST", body: fd });
          if (!res.ok) {
            const errBody = (await res.json().catch(() => ({}))) as {
              message?: string;
            };
            throw new Error(
              `Couldn't read "${entry.protocol.name}" (${res.status}). ${
                errBody.message ?? ""
              }`,
            );
          }

          const json = (await res.json()) as {
            ok: true;
            draft: DraftProtocol;
            allowed_overlap_groups: string[];
          };

          parsedList.push({
            personIndex: pi,
            protocolIndex: pr,
            name: personName,
            taskId: synthTaskId(
              personName,
              json.draft.protocol_name,
              taskCounter++,
            ),
            sampleCount: samples,
            protocolFile: entry.protocol,
            scheduleFile: person.schedule,
            scheduleText: scheduleTexts[pi] || "",
            draft: json.draft,
            allowedOverlapGroups: json.allowed_overlap_groups,
            confirmations: null,
          });
        }
      }

      if (parsedList.length === 0) {
        // Nothing to confirm — but the validation above already requires
        // each labmate to have at least one protocol. Treat this as an error.
        throw new Error("No protocols to parse. Upload at least one PDF.");
      }

      // 3. Drop into the review state. The user walks through each parsed
      //    draft and confirms (or overrides) the overlap groups.
      setStage({ kind: "review", parsed: parsedList, cursor: 0 });
    } catch (err) {
      setStage({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Something went wrong. Please try again.",
      });
    }
  }

  /** Called after the user clicks "Confirm" on the last review modal.
   *  Sends drafts + confirmations to /api/plan, which resolves them into
   *  EnrichedProtocols before running the engine + narrator. */
  async function finalizePlan(parsed: ParsedProtocol[]) {
    try {
      setStage({
        kind: "running",
        label: "Coordinating across the week",
        sub: "running engine + narrator",
      });

      // All parsed protocols belonging to a person, in original upload order.
      const parsedForPerson = (pi: number) =>
        parsed
          .filter((q) => q.personIndex === pi)
          .sort((a, b) => a.protocolIndex - b.protocolIndex);

      // Sequencing runs each become their OWN `people[]` entry — never folded
      // into a labmate card, even when the name matches one. See the
      // duplicate-name caveat on `SequencingRun` above: this only produces a
      // correct schedule when the same person's SAME calendar is uploaded in
      // both places. Read every row's calendar text up front (mirrors step 1
      // of handleSubmit for the labmate cards).
      const validSeqRuns = sequencingRuns.filter(
        (r) => r.name.trim() && parsePositiveInt(r.sampleCount, 0) > 0,
      );
      const seqScheduleTexts = await Promise.all(
        validSeqRuns.map((r) => (r.schedule ? r.schedule.text() : Promise.resolve(""))),
      );
      const seqTasks: SequencingTaskDraft[] = validSeqRuns.map((r, i) => {
        const sampleCount = parsePositiveInt(r.sampleCount, SEQUENCING_DEFAULT_SAMPLES);
        return {
          task_id: synthTaskId(r.name.trim(), "sequencing_run", i),
          draft: buildSequencingDraft(sampleCount),
          sample_count: sampleCount,
        };
      });

      // Build the rich submission payload — one entry per labmate card, plus
      // one entry per sequencing run.
      const submissionPeople: SubmissionPersonInput[] = [
        ...people.map((p, pi) => {
          const hits = parsedForPerson(pi);
          // We don't have final EnrichedProtocols on the client yet (that
          // happens server-side inside /api/plan), so `enriched` stays null;
          // the engine response carries the resolved data.
          const protocols: SubmissionProtocolInput[] = hits.map((hit) => ({
            filename: hit.protocolFile.name,
            size: hit.protocolFile.size,
            sample_count: hit.sampleCount,
            task_id: hit.taskId,
            // With the universal parser, "matched_protocol_name" is the parser's
            // title and the matcher is the LLM extractor.
            matched_protocol_name: hit.draft.protocol_name,
            matched_via: "llm",
            match_confidence: 1,
            enriched: null as never,
          }));
          return {
            name: p.name.trim(),
            schedule_filename: p.schedule?.name ?? null,
            schedule_size: p.schedule?.size ?? null,
            schedule_ics_text: hits[0]?.scheduleText ?? (p.schedule ? "" : null),
            protocols,
          };
        }),
        ...validSeqRuns.map((r, i) => ({
          name: r.name.trim(),
          schedule_filename: r.schedule?.name ?? null,
          schedule_size: r.schedule?.size ?? null,
          schedule_ics_text: seqScheduleTexts[i] ?? null,
          protocols: [sequencingTaskToProtocolInput(seqTasks[i])],
        })),
      ];

      // Plan request body: each labmate card carries one task per uploaded
      // protocol; each sequencing run is its own person entry with exactly
      // one fixed sequencing task. tasks carry `draft + confirmations +
      // sample_count` (universal-parser flow); /api/plan calls resolveDraft()
      // server side to produce the EnrichedProtocols the engine consumes.
      const planBody = {
        week_start_iso: weekStartIso,
        people: [
          ...people.map((p, pi) => {
            const hits = parsedForPerson(pi);
            return {
              name: p.name.trim(),
              busy_ics_text: hits[0]?.scheduleText || undefined,
              tasks: hits.map((hit) => ({
                task_id: hit.taskId,
                draft: hit.draft,
                confirmations: hit.confirmations ?? [],
                sample_count: hit.sampleCount,
              })),
            };
          }),
          ...validSeqRuns.map((r, i) => ({
            name: r.name.trim(),
            busy_ics_text: seqScheduleTexts[i] || undefined,
            tasks: [
              {
                task_id: seqTasks[i].task_id,
                draft: seqTasks[i].draft,
                confirmations: [],
                sample_count: seqTasks[i].sample_count,
              },
            ],
          })),
        ],
      };

      const planRes = await fetch("/api/plan?narrate=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planBody),
      });

      if (!planRes.ok) {
        const err = await planRes.text().catch(() => "");
        throw new Error(
          `Engine returned ${planRes.status}. ${err.slice(0, 240)}`,
        );
      }
      const plan = (await planRes.json()) as NarratedWeekPlanResult;

      // Legacy stub mirror (only `name` is read downstream — see
      // lib/submission.ts namesList). Represent the person with their first
      // uploaded protocol for the file/sampleCount columns.
      const legacyStubs: PersonStub[] = [
        ...people.map((p) => {
          const first = p.protocols.find((pr) => pr.protocol) ?? p.protocols[0];
          return {
            name: p.name.trim(),
            protocol: first?.protocol
              ? { name: first.protocol.name, size: first.protocol.size }
              : null,
            schedule: p.schedule
              ? { name: p.schedule.name, size: p.schedule.size }
              : null,
            sampleCount: first?.sampleCount.trim() ?? "",
          };
        }),
        ...validSeqRuns.map((r, i) => ({
          name: r.name.trim(),
          protocol: null,
          schedule: r.schedule
            ? { name: r.schedule.name, size: r.schedule.size }
            : null,
          sampleCount: String(seqTasks[i].sample_count),
        })),
      ];

      const submission: Submission = {
        submittedAt: new Date().toISOString(),
        people: legacyStubs,
        inputs: submissionPeople,
        plan,
      };

      try {
        saveSubmission(submission);
      } catch (storageErr) {
        throw new Error(
          `Couldn't save the plan locally (${(storageErr as Error).message}). Try smaller calendar files.`,
        );
      }

      setStage({ kind: "idle" });
      onSubmitted?.();
    } catch (err) {
      setStage({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Something went wrong. Please try again.",
      });
    }
  }

  function handleReviewConfirm(
    confirmations: ReagentConfirmation[],
  ) {
    if (stage.kind !== "review") return;
    const next = stage.parsed.map((p, i) =>
      i === stage.cursor ? { ...p, confirmations } : p,
    );
    const nextCursor = stage.cursor + 1;
    if (nextCursor >= next.length) {
      // All drafts confirmed — fire the plan request.
      void finalizePlan(next);
    } else {
      setStage({ kind: "review", parsed: next, cursor: nextCursor });
    }
  }

  function handleReviewBack(confirmations: ReagentConfirmation[]) {
    // Step back to the previous protocol in the wizard. Save the current
    // step's in-progress edits first, then re-seed them (and any earlier
    // step's) via initialConfirmations so nothing is lost on navigation.
    if (stage.kind !== "review" || stage.cursor === 0) return;
    const next = stage.parsed.map((p, i) =>
      i === stage.cursor ? { ...p, confirmations } : p,
    );
    setStage({ kind: "review", parsed: next, cursor: stage.cursor - 1 });
  }

  function handleReviewCancel() {
    // Bail back to the form. Drafts are discarded; the user can re-upload.
    setStage({ kind: "idle" });
  }

  const filledCount = people.filter(isPersonComplete).length;
  const sequencingRunsValid = sequencingRuns.every(isSequencingRunComplete);
  const canSubmit =
    filledCount === people.length && sequencingRunsValid && !submitting;

  return (
    <section
      id="home"
      className="section-snap relative min-h-screen w-full bg-earth-home px-6 py-24"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "repeating-radial-gradient(circle at 30% 40%, #3A5A40 0 1px, transparent 1px 42px)",
        }}
      />

      <div className="relative z-10 mx-auto max-w-7xl">
        <header className="mb-10 text-center">
          <p className="mb-3 inline-block rounded-full border border-forest-700/15 bg-white/50 px-3 py-1 text-[10px] uppercase tracking-[0.25em] text-forest-700/80 backdrop-blur">
            Step 1 · Plan the week
          </p>
          <h2 className="font-display text-4xl font-semibold tracking-tight text-forest-800 md:text-5xl">
            Fill in the fields below to start
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-forest-800/70">
            Add up to {MAX_PEOPLE} labmates. For each labmate, give their
            name and their calendar as an{" "}
            <code className="font-mono text-xs">.ics</code> file, then add one
            or more lab protocols — each with its own intended number of
            samples. We&rsquo;ll find overlaps.
          </p>

          <div className="mx-auto mt-6 flex max-w-md flex-col items-center gap-1.5">
            <label
              htmlFor="week-start-select"
              className="text-[10px] font-semibold uppercase tracking-[0.25em] text-forest-800/60"
            >
              Week to plan
            </label>
            <select
              id="week-start-select"
              value={weekStartIso}
              onChange={(e) => setWeekStartIso(e.target.value)}
              disabled={submitting}
              className="w-full max-w-xs rounded-full border border-forest-700/20 bg-white/80 px-4 py-2 text-center text-sm font-medium text-forest-800 shadow-soft outline-none transition focus:border-forest-700/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {weekOptions.map((opt) => (
                <option key={opt.iso} value={opt.iso}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="max-w-sm text-center text-[11px] leading-snug text-forest-800/50">
              We only look at busy times inside this week when reading each
              uploaded .ics calendar — everything else in the file is
              ignored for scheduling.
            </p>
          </div>
        </header>

        <form
          onSubmit={handleSubmit}
          className="rounded-3xl border border-forest-700/10 bg-white/70 p-6 shadow-soft backdrop-blur md:p-10"
        >
          <div className="space-y-6">
            {people.map((person, i) => (
              <PersonBlock
                key={i}
                index={i}
                person={person}
                onChange={(patch) => updatePerson(i, patch)}
                onProtocolChange={(pr, patch) => updateProtocol(i, pr, patch)}
                onAddProtocol={() => addProtocol(i)}
                onRemoveProtocol={(pr) => removeProtocol(i, pr)}
                onRemove={
                  people.length > MIN_PEOPLE ? () => removePerson(i) : undefined
                }
              />
            ))}
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={addPerson}
              disabled={people.length >= MAX_PEOPLE || submitting}
              className="group inline-flex items-center gap-2 rounded-full border border-forest-700/20 bg-white/70 px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-forest-800 shadow-soft transition enabled:hover:border-forest-700/40 enabled:hover:bg-white enabled:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              <span>
                {people.length >= MAX_PEOPLE
                  ? `Max ${MAX_PEOPLE} labmates`
                  : "Add labmate"}
              </span>
            </button>
          </div>

          <div className="mt-10 border-t border-forest-700/10 pt-8">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-xl font-semibold text-forest-800">
                  Sequencing runs{" "}
                  <span className="text-sm font-normal text-forest-800/50">
                    (optional)
                  </span>
                </h3>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-forest-800/55">
                  Running samples through the sequencer this week? Add one
                  entry per person — name, sample count, and their calendar.
                  No protocol file needed. If this person already has a
                  labmate card above, upload their <strong>same</strong>{" "}
                  calendar file here too, so their busy times stay accurate.
                  We&rsquo;ll pool sequencing runs across labmates the same
                  way we pool everything else.
                </p>
              </div>
              <span className="shrink-0 text-[11px] text-forest-800/45">
                {sequencingRuns.length}/{MAX_SEQUENCING_RUNS}
              </span>
            </div>

            {sequencingRuns.length > 0 && (
              <div className="space-y-3">
                {sequencingRuns.map((run, i) => (
                  <SequencingRunRow
                    key={i}
                    run={run}
                    onChange={(patch) => updateSequencingRun(i, patch)}
                    onRemove={() => removeSequencingRun(i)}
                  />
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={addSequencingRun}
              disabled={sequencingRuns.length >= MAX_SEQUENCING_RUNS || submitting}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-forest-700/15 bg-white/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-forest-800/75 transition enabled:hover:border-moss-500/50 enabled:hover:bg-moss-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              {sequencingRuns.length >= MAX_SEQUENCING_RUNS
                ? `Max ${MAX_SEQUENCING_RUNS} sequencing runs`
                : "Add sequencing run"}
            </button>

            {sequencingRuns.length > 0 && !sequencingRunsValid && (
              <p className="mt-2 text-xs text-clay-600">
                Each sequencing run needs a name, a sample count, and a
                calendar before you can submit.
              </p>
            )}
          </div>

          {stage.kind === "error" && (
            <div className="mt-8 rounded-xl border border-clay-400/30 bg-clay-400/10 px-4 py-3 text-sm text-clay-700">
              {stage.message}
            </div>
          )}

          <div className="mt-10 flex flex-col items-center justify-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="group inline-flex items-center gap-3 rounded-full bg-forest-700 px-10 py-4 text-sm font-semibold uppercase tracking-[0.2em] text-sand-50 shadow-soft transition enabled:hover:bg-forest-800 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>{submitting ? "Working…" : "Submit"}</span>
              <svg
                className="h-4 w-4 transition group-enabled:group-hover:translate-x-1"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14" />
                <path d="M13 5l7 7-7 7" />
              </svg>
            </button>
            <p className="text-xs text-forest-800/60">
              {canSubmit
                ? `All ${people.length} ${
                    people.length === 1 ? "labmate" : "labmates"
                  } complete — ready to plan.`
                : `Fill in every field for all ${people.length} ${
                    people.length === 1 ? "labmate" : "labmates"
                  } to continue. (${filledCount} of ${people.length} complete.)`}
            </p>
          </div>
        </form>

        <p className="mt-8 text-center text-xs text-forest-800/50">
          Your files stay in your browser — LabSync is stateless.
        </p>
      </div>

      <div className="relative z-10 mt-20">
        <Footer />
      </div>

      {stage.kind === "running" && <SubmittingOverlay stage={stage} />}

      {stage.kind === "review" && (
        <ProtocolDraftReview
          key={`review-${stage.cursor}`}
          personName={stage.parsed[stage.cursor].name}
          filename={stage.parsed[stage.cursor].protocolFile.name}
          sampleCount={stage.parsed[stage.cursor].sampleCount}
          draft={stage.parsed[stage.cursor].draft}
          allowedOverlapGroups={
            stage.parsed[stage.cursor].allowedOverlapGroups
          }
          initialConfirmations={stage.parsed[stage.cursor].confirmations}
          stepIndex={stage.cursor}
          stepCount={stage.parsed.length}
          onBack={stage.cursor > 0 ? handleReviewBack : undefined}
          onConfirm={handleReviewConfirm}
          onCancel={handleReviewCancel}
        />
      )}
    </section>
  );
}

/* ---------- Submitting overlay ---------- */

function SubmittingOverlay({
  stage,
}: {
  stage: { kind: "running"; label: string; sub?: string };
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-forest-900/40 backdrop-blur-sm">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl border border-forest-700/10 bg-white p-8 text-center shadow-soft">
        <Spinner />
        <p className="font-display text-lg font-semibold text-forest-800">
          {stage.label}
        </p>
        {stage.sub && (
          <p className="text-xs text-forest-800/65">{stage.sub}</p>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-8 w-8 animate-spin text-forest-700"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

/* ---------- Per-person block ---------- */

const ACCENTS = ["moss", "ocean", "sand"] as const;
type Accent = (typeof ACCENTS)[number];

function PersonBlock({
  index,
  person,
  onChange,
  onProtocolChange,
  onAddProtocol,
  onRemoveProtocol,
  onRemove,
}: {
  index: number;
  person: Person;
  onChange: (patch: Partial<Person>) => void;
  onProtocolChange: (protocolIndex: number, patch: Partial<ProtocolEntry>) => void;
  onAddProtocol: () => void;
  onRemoveProtocol: (protocolIndex: number) => void;
  onRemove?: () => void;
}) {
  const accent: Accent = ACCENTS[index % ACCENTS.length];

  const badge =
    accent === "moss"
      ? "bg-moss-100 text-moss-700 ring-moss-500/30"
      : accent === "ocean"
      ? "bg-ocean-100 text-ocean-700 ring-ocean-400/30"
      : "bg-sand-200 text-clay-600 ring-clay-400/30";

  const complete = isPersonComplete(person);

  return (
    <div className="rounded-2xl border border-forest-700/10 bg-white/60 p-5 md:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-xl font-display text-base font-semibold ring-1 ${badge}`}
          >
            {index + 1}
          </span>
          <div>
            <h3 className="font-display text-xl font-semibold text-forest-800">
              Labmate {index + 1}
            </h3>
            <p className="text-xs text-forest-800/55">
              Name and schedule, plus one or more protocols (each with its
              own sample count)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {complete && (
            <span className="flex items-center gap-1.5 rounded-full bg-moss-100 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-moss-700">
              <svg
                viewBox="0 0 24 24"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12l5 5L20 7" />
              </svg>
              Ready
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove labmate ${index + 1}`}
              title="Remove labmate"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-forest-700/10 bg-white/70 text-forest-800/55 transition hover:border-clay-400/40 hover:bg-clay-400/10 hover:text-clay-700"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Per-person fields: name + one shared calendar. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:items-end">
        <div className="flex flex-col">
          <Label text="Name" />
          <input
            type="text"
            value={person.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={index === 0 ? "e.g. Sohini" : `Labmate ${index + 1}`}
            className="h-[74px] w-full rounded-xl border border-forest-700/15 bg-white/90 px-4 text-sm text-forest-900 outline-none transition placeholder:text-forest-900/35 focus:border-moss-500 focus:ring-4 focus:ring-moss-400/20"
          />
        </div>

        <div className="flex flex-col">
          <Label text="Schedule (.ics)" />
          <FileDropSlot
            accept=".ics"
            file={person.schedule}
            onChange={(f) => onChange({ schedule: f })}
            accent="ocean"
            placeholder="Drop .ics or click"
          />
        </div>
      </div>

      {/* Protocols: one or more per labmate, each with its own sample count. */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <Label text={person.protocols.length > 1 ? "Lab protocols" : "Lab protocol"} />
          <span className="text-[11px] text-forest-800/45">
            {person.protocols.length}/{MAX_PROTOCOLS_PER_PERSON}
          </span>
        </div>

        <div className="space-y-3">
          {person.protocols.map((entry, pr) => (
            <div
              key={pr}
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <FileDropSlot
                  accept=".pdf,.doc,.docx,.txt,.md"
                  file={entry.protocol}
                  onChange={(f) => onProtocolChange(pr, { protocol: f })}
                  accent="moss"
                  placeholder="Drop protocol or click"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={entry.sampleCount}
                  onChange={(e) =>
                    onProtocolChange(pr, { sampleCount: e.target.value })
                  }
                  placeholder="Number of samples (e.g. 8)"
                  aria-label={`Number of samples for protocol ${pr + 1}`}
                  className="h-[74px] w-full rounded-xl border border-forest-700/15 bg-white/90 px-4 text-sm text-forest-900 outline-none transition placeholder:text-forest-900/35 focus:border-moss-500 focus:ring-4 focus:ring-moss-400/20"
                />
              </div>
              {person.protocols.length > MIN_PROTOCOLS && (
                <button
                  type="button"
                  onClick={() => onRemoveProtocol(pr)}
                  aria-label={`Remove protocol ${pr + 1}`}
                  title="Remove protocol"
                  className="flex h-[74px] w-10 items-center justify-center self-start rounded-xl border border-forest-700/10 bg-white/70 text-forest-800/55 transition hover:border-clay-400/40 hover:bg-clay-400/10 hover:text-clay-700"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 6l12 12" />
                    <path d="M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>

        {person.protocols.length < MAX_PROTOCOLS_PER_PERSON && (
          <button
            type="button"
            onClick={onAddProtocol}
            className="mt-3 inline-flex items-center gap-2 rounded-full border border-forest-700/15 bg-white/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-forest-800/75 transition hover:border-moss-500/50 hover:bg-moss-50"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            Add another protocol
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- Sequencing run row ---------- */

function SequencingRunRow({
  run,
  onChange,
  onRemove,
}: {
  run: SequencingRun;
  onChange: (patch: Partial<SequencingRun>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-2xl border border-forest-700/10 bg-white/60 p-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div className="flex flex-col">
          <Label text="Name" />
          <input
            type="text"
            value={run.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Sohini"
            aria-label="Name of the person running this sequencing run"
            className="h-[74px] w-full rounded-xl border border-forest-700/15 bg-white/90 px-4 text-sm text-forest-900 outline-none transition placeholder:text-forest-900/35 focus:border-moss-500 focus:ring-4 focus:ring-moss-400/20"
          />
        </div>

        <div className="flex flex-col">
          <Label text="Run type" />
          {/* Only one option today. A real <select> (rather than a static
              label) so a second instrument type is a one-line addition
              later, not a UI rewrite. */}
          <select
            value="sequencing_run"
            disabled
            aria-label="Run type"
            className="h-[74px] w-full cursor-not-allowed rounded-xl border border-forest-700/15 bg-white/70 px-4 text-sm text-forest-900 outline-none"
          >
            <option value="sequencing_run">Sequencing run</option>
          </select>
        </div>

        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove sequencing run"
          title="Remove sequencing run"
          className="flex h-[74px] w-10 items-center justify-center justify-self-end rounded-xl border border-forest-700/10 bg-white/70 text-forest-800/55 transition hover:border-clay-400/40 hover:bg-clay-400/10 hover:text-clay-700"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 6l12 12" />
            <path d="M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col">
          <Label text="Number of samples" />
          <input
            type="text"
            inputMode="numeric"
            value={run.sampleCount}
            onChange={(e) => onChange({ sampleCount: e.target.value })}
            placeholder="e.g. 96"
            aria-label="Number of samples for this sequencing run"
            className="h-[74px] w-full rounded-xl border border-forest-700/15 bg-white/90 px-4 text-sm text-forest-900 outline-none transition placeholder:text-forest-900/35 focus:border-moss-500 focus:ring-4 focus:ring-moss-400/20"
          />
        </div>

        <div className="flex flex-col">
          <Label text="Schedule (.ics)" />
          <FileDropSlot
            accept=".ics"
            file={run.schedule}
            onChange={(f) => onChange({ schedule: f })}
            accent="ocean"
            placeholder="Drop .ics or click"
          />
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-forest-800/50">
        If this is the same person as one of your labmates above, upload
        their <strong>same</strong> calendar file here too. Uploading a
        different (or no) calendar for the same name can make the engine
        miscalculate that person&rsquo;s free time.
      </p>
    </div>
  );
}

function Label({ text }: { text: string }) {
  return (
    <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-forest-800/65">
      {text}
    </label>
  );
}

/* ---------- File drop slot ---------- */
function FileDropSlot({
  accept,
  file,
  onChange,
  accent,
  placeholder,
}: {
  accept: string;
  file: File | null;
  onChange: (f: File | null) => void;
  accent: "moss" | "ocean";
  placeholder: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const accentCls =
    accent === "moss"
      ? "hover:border-moss-500/60 hover:bg-moss-50"
      : "hover:border-ocean-400/60 hover:bg-ocean-100/40";
  const filledCls =
    accent === "moss"
      ? "border-moss-500 bg-moss-50"
      : "border-ocean-400 bg-ocean-100/60";

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onChange(f);
      }}
      className={`group relative flex h-[74px] cursor-pointer flex-col items-start justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-3 text-sm transition ${
        file ? filledCls : `border-forest-700/15 bg-white/70 ${accentCls}`
      } ${dragOver ? "scale-[1.01]" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="file-input-hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <div className="flex w-full items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-forest-800">
              {file.name}
            </p>
            <p className="text-[11px] text-forest-800/55">
              {(file.size / 1024).toFixed(1)} KB
            </p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="shrink-0 text-xs text-clay-500 hover:text-clay-700"
            aria-label="Remove file"
          >
            remove
          </button>
        </div>
      ) : (
        <span className="text-sm text-forest-800/50">{placeholder}</span>
      )}
    </label>
  );
}

/* ---------- helpers ---------- */

/** A labmate is ready to submit when they have a name, a calendar, and every
 *  protocol slot has both a file and a valid positive sample count. */
function isPersonComplete(p: Person): boolean {
  return (
    !!p.name.trim() &&
    !!p.schedule &&
    p.protocols.length >= MIN_PROTOCOLS &&
    p.protocols.every(
      (pr) =>
        !!pr.protocol &&
        !!pr.sampleCount.trim() &&
        parsePositiveInt(pr.sampleCount, 0) > 0,
    )
  );
}

function parsePositiveInt(raw: string, fallback: number): number {
  // Math.round (instead of parseInt) so "8.7" rounds to 9 — the backend's
  // /api/match handler now does the same, and the two sides agreeing matters
  // because the same number is later sent to /api/plan as the canonical
  // sample count for impact math.
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

/** A sequencing-run row is ready to submit when it has a name, a positive
 *  sample count, AND a calendar. Unlike a labmate card's calendar (which is
 *  genuinely optional in spirit but required by isPersonComplete anyway),
 *  the calendar here is load-bearing for a second reason: it's what the user
 *  re-enters to keep a duplicate-named entry safe (see the caveat on
 *  `SequencingRun` above). Making it required in the UI nudges the correct
 *  workflow instead of silently accepting a row that would corrupt that
 *  person's schedule. */
function isSequencingRunComplete(r: SequencingRun): boolean {
  return (
    !!r.name.trim() &&
    !!r.schedule &&
    !!r.sampleCount.trim() &&
    parsePositiveInt(r.sampleCount, 0) > 0
  );
}

const SEQUENCING_DEFAULT_SAMPLES = 96;
const SEQUENCING_MAX_SAMPLES = 384;

/** Emits the fixed DraftProtocol the pooled-sequencing family expects —
 *  byte-for-byte the same shape `scripts/fixtures.ts::sequencingProtocol`
 *  builds and `scripts/test-engine.ts` exercises (verified there to pool
 *  correctly across labmates: same family + equipment_group means the
 *  matcher's `buildEquipmentCoordinations` groups them into one
 *  shared_equipment_run on the seeded `miseq-i100-1` catalog row). The only
 *  variable is `samples_default`; reagents stay empty (the sequencing kit is
 *  a per-run consumable costed via equipment.csv, not a pipetted reagent).
 *  No LLM call — this never goes through /api/parse. It still goes through
 *  the same server-side `resolveDraft` step an LLM-parsed draft would, so
 *  the engine treats it identically to a parsed PDF. */
function buildSequencingDraft(sampleCount: number): DraftProtocol {
  return {
    protocol_name: "MiSeq i100 pooled amplicon sequencing",
    vendor: "Illumina / UCSD IGM",
    family: "Sequencing",
    primary_technique: "pooled_amplicon_sequencing_miseq",
    samples_default: sampleCount,
    samples_max: SEQUENCING_MAX_SAMPLES,
    reagents: [],
    equipment_required: [
      { equipment_type: "sequencer", model_hint: "Illumina MiSeq i100" },
    ],
    thermal_profile: null,
    missing_information: [],
  };
}

interface SequencingTaskDraft {
  task_id: string;
  draft: DraftProtocol;
  sample_count: number;
}

/** Turn one sequencing task draft into the submission record's per-protocol
 *  shape. There's no real file, so `filename` is a descriptive placeholder
 *  and `size` is 0 — downstream UI treats this the same as any other
 *  protocol entry. */
function sequencingTaskToProtocolInput(
  t: SequencingTaskDraft,
): SubmissionProtocolInput {
  return {
    filename: t.draft.protocol_name,
    size: 0,
    sample_count: t.sample_count,
    task_id: t.task_id,
    matched_protocol_name: t.draft.protocol_name,
    matched_via: "manual",
    match_confidence: 1,
    enriched: null as never,
  };
}

function synthTaskId(
  personName: string,
  protocolName: string,
  index: number,
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "x";
  return `${slug(personName)}__${slug(protocolName)}__${index}`;
}
