"use client";

import { useRef, useState } from "react";
import { Footer } from "@/components/OverviewPage";
import {
  saveSubmission,
  type PersonStub,
  type Submission,
  type SubmissionPersonInput,
  type SubmissionProtocolInput,
} from "@/lib/submission";
import type {
  EnrichedProtocol,
  NarratedWeekPlanResult,
  ProtocolMatchResult,
} from "@/lib/engine/types";

export type Person = {
  name: string;
  protocol: File | null;
  schedule: File | null;
  sampleCount: string;
};

export const EMPTY_PERSON: Person = {
  name: "",
  protocol: null,
  schedule: null,
  sampleCount: "",
};

type HomeFormProps = {
  people: Person[];
  setPeople: React.Dispatch<React.SetStateAction<Person[]>>;
  onSubmitted?: () => void;
};

type Stage =
  | { kind: "idle" }
  | { kind: "running"; label: string; sub?: string }
  | { kind: "error"; message: string };

export default function HomeForm({
  people,
  setPeople,
  onSubmitted,
}: HomeFormProps) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const submitting = stage.kind === "running";

  function updatePerson(index: number, patch: Partial<Person>) {
    setPeople((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    try {
      // 1. Read calendar files (.ics) into text up front.
      setStage({ kind: "running", label: "Reading calendar files…" });
      const scheduleTexts = await Promise.all(
        people.map((p) => (p.schedule ? p.schedule.text() : Promise.resolve(""))),
      );

      // 2. For each person × protocol, hit /api/match (with hydrate) and
      //    collect enriched protocols.
      const submissionPeople: SubmissionPersonInput[] = [];
      const total = people.reduce(
        (acc, p) => acc + (p.protocol ? 1 : 0),
        0,
      );
      let done = 0;

      for (let pi = 0; pi < people.length; pi++) {
        const person = people[pi];
        const personName = person.name.trim();
        const submissionProtocols: SubmissionProtocolInput[] = [];

        if (person.protocol) {
          done += 1;
          setStage({
            kind: "running",
            label: "Matching protocols",
            sub: `(${done}/${total}) ${personName} · ${person.protocol.name}`,
          });

          const samples = parsePositiveInt(person.sampleCount, 8);
          const fd = new FormData();
          fd.append("file", person.protocol);
          fd.append("samples", String(samples));
          fd.append("hydrate", "1");

          const res = await fetch("/api/match", { method: "POST", body: fd });
          if (!res.ok) {
            const err = await res.text().catch(() => "");
            throw new Error(
              `Couldn't match "${person.protocol.name}" (${res.status}). ${err.slice(
                0,
                200,
              )}`,
            );
          }
          const json = (await res.json()) as {
            match: ProtocolMatchResult;
            enriched: EnrichedProtocol | null;
            hydrate_error?: { code: string; message: string };
          };

          if (!json.enriched || !json.match.protocol_name) {
            throw new Error(
              `Couldn't recognize "${person.protocol.name}" as one of the seeded protocols. ${
                json.hydrate_error?.message ?? json.match.notes
              }`,
            );
          }

          submissionProtocols.push({
            filename: person.protocol.name,
            size: person.protocol.size,
            sample_count: samples,
            task_id: synthTaskId(personName, json.match.protocol_name, pi),
            matched_protocol_name: json.match.protocol_name,
            matched_via: json.match.matched_via,
            match_confidence: json.match.confidence,
            enriched: json.enriched,
          });
        }

        submissionPeople.push({
          name: personName,
          schedule_filename: person.schedule?.name ?? null,
          schedule_size: person.schedule?.size ?? null,
          schedule_ics_text: scheduleTexts[pi] || null,
          protocols: submissionProtocols,
        });
      }

      // 3. Run the engine + narrator.
      setStage({
        kind: "running",
        label: "Coordinating across the week",
        sub: "running engine + narrator",
      });

      const planBody = {
        people: submissionPeople.map((p) => ({
          name: p.name,
          busy_ics_text: p.schedule_ics_text ?? undefined,
          tasks: p.protocols.map((pr) => ({
            task_id: pr.task_id,
            protocol: pr.enriched,
          })),
        })),
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

      // 4. Persist and advance the wizard.
      const legacyStubs: PersonStub[] = people.map((p) => ({
        name: p.name.trim(),
        protocol: p.protocol
          ? { name: p.protocol.name, size: p.protocol.size }
          : null,
        schedule: p.schedule
          ? { name: p.schedule.name, size: p.schedule.size }
          : null,
        sampleCount: p.sampleCount.trim(),
      }));

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

  const filledCount = people.filter(
    (p) =>
      p.name.trim() &&
      p.protocol &&
      p.schedule &&
      p.sampleCount.trim() &&
      parsePositiveInt(p.sampleCount, 0) > 0,
  ).length;
  const canSubmit = filledCount === people.length && !submitting;

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
            Add up to three labmates. For each labmate, give their name,
            upload their lab protocol, their calendar as an{" "}
            <code className="font-mono text-xs">.ics</code> file, and their
            intended number of samples in their experiment. We&rsquo;ll find
            overlaps.
          </p>
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
              />
            ))}
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
                ? "All 3 people complete — ready to plan."
                : `Fill in every field for all 3 people to continue. (${filledCount} of 3 complete.)`}
            </p>
          </div>
        </form>

        <p className="mt-8 text-center text-xs text-forest-800/50">
          Your files stay in your browser — Green Bench is stateless.
        </p>
      </div>

      <div className="relative z-10 mt-20">
        <Footer />
      </div>

      {submitting && <SubmittingOverlay stage={stage} />}
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
}: {
  index: number;
  person: Person;
  onChange: (patch: Partial<Person>) => void;
}) {
  const accent: Accent = ACCENTS[index % ACCENTS.length];

  const badge =
    accent === "moss"
      ? "bg-moss-100 text-moss-700 ring-moss-500/30"
      : accent === "ocean"
      ? "bg-ocean-100 text-ocean-700 ring-ocean-400/30"
      : "bg-sand-200 text-clay-600 ring-clay-400/30";

  const complete =
    !!person.name.trim() &&
    !!person.protocol &&
    !!person.schedule &&
    !!person.sampleCount.trim();

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
              Name, lab protocol, schedule, and number of intended samples
            </p>
          </div>
        </div>
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
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        {/* Name */}
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

        {/* Lab Protocol */}
        <div className="flex flex-col">
          <Label text="Lab Protocol" />
          <FileDropSlot
            accept=".pdf,.doc,.docx,.txt,.md"
            file={person.protocol}
            onChange={(f) => onChange({ protocol: f })}
            accent="moss"
            placeholder="Drop protocol or click"
          />
        </div>

        {/* Schedule (.ics) */}
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

        {/* Number of Samples */}
        <div className="flex flex-col">
          <Label text="Number of Samples" />
          <input
            type="text"
            inputMode="numeric"
            value={person.sampleCount}
            onChange={(e) => onChange({ sampleCount: e.target.value })}
            placeholder="e.g. 8"
            className="h-[74px] w-full rounded-xl border border-forest-700/15 bg-white/90 px-4 text-sm text-forest-900 outline-none transition placeholder:text-forest-900/35 focus:border-moss-500 focus:ring-4 focus:ring-moss-400/20"
          />
        </div>
      </div>
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

function parsePositiveInt(raw: string, fallback: number): number {
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
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
