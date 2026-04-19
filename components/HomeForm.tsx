"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import type {
  EnrichedProtocol,
  NarratedWeekPlanResult,
  ProtocolMatchResult,
} from "@/lib/engine/types";

/* ---------- Data model ---------- */
//
// Each person has ONE schedule (.ics) and 1..N protocol entries. The schedule
// is per-person because it represents that human's busy calendar; protocols
// are repeatable because the README envisions a person running multiple
// protocols in the same week. The engine accepts `tasks: HydratedTask[]` per
// person already — this UI now feeds it the array via the LLM-layer routes.

type ProtocolEntry = {
  protocol: File | null;
  sampleCount: string;
};

type Person = {
  name: string;
  schedule: File | null;
  protocols: ProtocolEntry[];
};

const EMPTY_PROTOCOL: ProtocolEntry = { protocol: null, sampleCount: "" };
const EMPTY_PERSON: Person = {
  name: "",
  schedule: null,
  protocols: [{ ...EMPTY_PROTOCOL }],
};

const MAX_PROTOCOLS_PER_PERSON = 4;

/* ---------- Shape stored in sessionStorage for the results page ---------- */
//
// The form persists the engine's narrated plan PLUS enough per-person input
// metadata to drive the Plan / Coordinate / Export tabs without re-uploading
// anything. The narrated plan is the single source of truth for numbers,
// citations, prose, and the schedule grid.

export type SubmissionPersonInput = {
  name: string;
  schedule_filename: string | null;
  schedule_size: number | null;
  /** Raw .ics text — needed by the export tab so it can pass-through the
   *  user's existing busy events into the per-person download. */
  schedule_ics_text: string | null;
  protocols: SubmissionProtocolInput[];
};

export type SubmissionProtocolInput = {
  filename: string;
  size: number;
  sample_count: number;
  /** Synthesized client-side so the results UI can join back to scheduled tasks. */
  task_id: string;
  /** Resolved canonical protocol (one of the 9 seeded names) or null on miss. */
  matched_protocol_name: string | null;
  matched_via: ProtocolMatchResult["matched_via"];
  match_confidence: number;
  /** Hydrated protocol that was actually fed to the engine; null if matching failed. */
  enriched: EnrichedProtocol | null;
};

export type Submission = {
  submittedAt: string;
  people: SubmissionPersonInput[];
  plan: NarratedWeekPlanResult;
};

/* ---------- HomeForm ---------- */

type Stage =
  | { kind: "idle" }
  | { kind: "running"; label: string; sub?: string }
  | { kind: "error"; message: string };

export default function HomeForm() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([
    { ...EMPTY_PERSON, protocols: [{ ...EMPTY_PROTOCOL }] },
    { ...EMPTY_PERSON, protocols: [{ ...EMPTY_PROTOCOL }] },
    { ...EMPTY_PERSON, protocols: [{ ...EMPTY_PROTOCOL }] },
  ]);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  function updatePerson(index: number, patch: Partial<Person>) {
    setPeople((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function updateProtocol(
    personIdx: number,
    protoIdx: number,
    patch: Partial<ProtocolEntry>
  ) {
    setPeople((prev) => {
      const next = [...prev];
      const protocols = [...next[personIdx].protocols];
      protocols[protoIdx] = { ...protocols[protoIdx], ...patch };
      next[personIdx] = { ...next[personIdx], protocols };
      return next;
    });
  }

  function addProtocol(personIdx: number) {
    setPeople((prev) => {
      const next = [...prev];
      if (next[personIdx].protocols.length >= MAX_PROTOCOLS_PER_PERSON) return prev;
      next[personIdx] = {
        ...next[personIdx],
        protocols: [...next[personIdx].protocols, { ...EMPTY_PROTOCOL }],
      };
      return next;
    });
  }

  function removeProtocol(personIdx: number, protoIdx: number) {
    setPeople((prev) => {
      const next = [...prev];
      // Always keep at least one protocol slot per person.
      if (next[personIdx].protocols.length <= 1) return prev;
      const protocols = next[personIdx].protocols.filter((_, i) => i !== protoIdx);
      next[personIdx] = { ...next[personIdx], protocols };
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (stage.kind === "running") return;

    try {
      setStage({ kind: "running", label: "Reading calendar files…" });
      const scheduleTexts = await Promise.all(
        people.map((p) => (p.schedule ? p.schedule.text() : Promise.resolve("")))
      );

      // 1. Match + hydrate every protocol via /api/match.
      //    We do this person-by-person, protocol-by-protocol with progress
      //    updates so the demo doesn't look frozen during a 4–5s run.
      const submissionPeople: SubmissionPersonInput[] = [];
      let total = 0;
      for (const p of people) total += p.protocols.length;
      let done = 0;

      for (let pi = 0; pi < people.length; pi++) {
        const person = people[pi];
        const personName = person.name.trim();
        const submissionProtocols: SubmissionProtocolInput[] = [];

        for (let ti = 0; ti < person.protocols.length; ti++) {
          const entry = person.protocols[ti];
          if (!entry.protocol) continue;
          done += 1;
          setStage({
            kind: "running",
            label: "Matching protocols",
            sub: `(${done}/${total}) ${personName} · ${entry.protocol.name}`,
          });

          const samples = parsePositiveInt(entry.sampleCount, 8);
          const fd = new FormData();
          fd.append("file", entry.protocol);
          fd.append("samples", String(samples));
          fd.append("hydrate", "1");

          const res = await fetch("/api/match", { method: "POST", body: fd });
          if (!res.ok) {
            const err = await res.text().catch(() => "");
            throw new Error(
              `Couldn't match "${entry.protocol.name}" (${res.status}). ${err.slice(0, 200)}`
            );
          }
          const json = (await res.json()) as {
            match: ProtocolMatchResult;
            enriched: EnrichedProtocol | null;
            hydrate_error?: { code: string; message: string };
          };

          if (!json.enriched || !json.match.protocol_name) {
            throw new Error(
              `Couldn't recognize "${entry.protocol.name}" as one of the seeded protocols. ${
                json.hydrate_error?.message ?? json.match.notes
              }`
            );
          }

          submissionProtocols.push({
            filename: entry.protocol.name,
            size: entry.protocol.size,
            sample_count: samples,
            task_id: synthTaskId(personName, json.match.protocol_name, ti),
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

      // 2. Plan the week and narrate in a single round-trip via ?narrate=1.
      setStage({
        kind: "running",
        label: "Coordinating across the week",
        sub: "running engine + narrator",
      });

      const planBody = {
        people: submissionPeople.map((p) => ({
          name: p.name,
          busy_ics_text: p.schedule_ics_text ?? undefined,
          tasks: p.protocols
            .filter((pr) => pr.enriched)
            .map((pr) => ({
              task_id: pr.task_id,
              protocol: pr.enriched!,
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
          `Engine returned ${planRes.status}. ${err.slice(0, 240)}`
        );
      }
      const plan = (await planRes.json()) as NarratedWeekPlanResult;

      // 3. Persist to sessionStorage and navigate. We strip nothing — the
      //    results page renders directly off this object.
      const submission: Submission = {
        submittedAt: new Date().toISOString(),
        people: submissionPeople,
        plan,
      };

      try {
        sessionStorage.setItem(
          "greenbench.submission",
          JSON.stringify(submission)
        );
      } catch (storageErr) {
        // sessionStorage quota busted — likely a giant ICS upload. Surface
        // a friendly error rather than navigating to an empty results page.
        throw new Error(
          `Couldn't save the plan locally (${(storageErr as Error).message}). Try smaller calendar files.`
        );
      }

      router.push("/results");
    } catch (err) {
      setStage({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Something went wrong. Please try again.",
      });
    }
  }

  // A person is complete when: name + schedule exist AND every protocol entry
  // has both a file and a sample count. (Never zero protocol entries.)
  const personComplete = (p: Person) =>
    !!p.name.trim() &&
    !!p.schedule &&
    p.protocols.length > 0 &&
    p.protocols.every(
      (pe) => !!pe.protocol && !!pe.sampleCount.trim() && parsePositiveInt(pe.sampleCount, 0) > 0
    );

  const filledCount = people.filter(personComplete).length;
  const submitting = stage.kind === "running";
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

      <div className="relative z-10 mx-auto max-w-4xl">
        <header className="mb-10 text-center">
          <p className="mb-3 inline-block rounded-full border border-forest-700/15 bg-white/50 px-3 py-1 text-[10px] uppercase tracking-[0.25em] text-forest-700/80 backdrop-blur">
            Step 1 · Plan the week
          </p>
          <h2 className="font-display text-4xl font-semibold tracking-tight text-forest-800 md:text-5xl">
            Fill in the fields below to start
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-forest-800/70">
            Add up to three people. For each person, give their name, upload
            their calendar as an{" "}
            <code className="font-mono text-xs">.ics</code> file, then add one
            or more lab protocols with intended sample counts. We&rsquo;ll find
            overlaps across all of them.
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
                onProtocolChange={(protoIdx, patch) =>
                  updateProtocol(i, protoIdx, patch)
                }
                onAddProtocol={() => addProtocol(i)}
                onRemoveProtocol={(protoIdx) => removeProtocol(i, protoIdx)}
                isComplete={personComplete(person)}
              />
            ))}
          </div>

          {stage.kind === "error" && (
            <div className="mt-8 rounded-2xl border border-clay-400/40 bg-clay-400/10 px-5 py-4 text-sm text-clay-700">
              <p className="font-semibold">We couldn&rsquo;t plan this week.</p>
              <p className="mt-1 leading-relaxed">{stage.message}</p>
              <button
                type="button"
                onClick={() => setStage({ kind: "idle" })}
                className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-clay-600 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="mt-10 flex flex-col items-center justify-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="group inline-flex items-center gap-3 rounded-full bg-forest-700 px-10 py-4 text-sm font-semibold uppercase tracking-[0.2em] text-sand-50 shadow-soft transition enabled:hover:bg-forest-800 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>{submitting ? "Planning…" : "Submit"}</span>
              {submitting ? (
                <Spinner />
              ) : (
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
              )}
            </button>
            <p className="text-xs text-forest-800/60">
              {submitting
                ? `${stage.label}${stage.sub ? ` · ${stage.sub}` : ""}`
                : canSubmit
                ? "All 3 people complete — ready to plan."
                : `Fill in every field for all 3 people (each protocol needs a file and a sample count). (${filledCount} of 3 complete.)`}
            </p>
          </div>
        </form>

        <p className="mt-8 text-center text-xs text-forest-800/50">
          Your files stay in your browser — Green Bench is stateless.
        </p>
      </div>

      {submitting && <SubmittingOverlay stage={stage} />}
    </section>
  );
}

/* ---------- Submitting overlay ---------- */

function SubmittingOverlay({ stage }: { stage: Stage }) {
  if (stage.kind !== "running") return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-forest-900/40 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-3xl border border-forest-700/15 bg-white/95 p-8 shadow-2xl">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-forest-700 text-sand-50">
            <Spinner />
          </span>
          <div className="flex-1">
            <p className="font-display text-lg font-semibold text-forest-800">
              {stage.label}
            </p>
            {stage.sub && (
              <p className="mt-1 truncate text-xs text-forest-800/60">
                {stage.sub}
              </p>
            )}
          </div>
        </div>
        <p className="mt-5 text-xs text-forest-800/60">
          We&rsquo;re matching each protocol to one of the 9 curated kits,
          hydrating reagents from the EPA cache, then running the deterministic
          scheduler and the narrator. Usually takes 5–15 seconds.
        </p>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
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
  isComplete,
}: {
  index: number;
  person: Person;
  onChange: (patch: Partial<Person>) => void;
  onProtocolChange: (protoIdx: number, patch: Partial<ProtocolEntry>) => void;
  onAddProtocol: () => void;
  onRemoveProtocol: (protoIdx: number) => void;
  isComplete: boolean;
}) {
  const accent: Accent = ACCENTS[index % ACCENTS.length];

  const badge =
    accent === "moss"
      ? "bg-moss-100 text-moss-700 ring-moss-500/30"
      : accent === "ocean"
      ? "bg-ocean-100 text-ocean-700 ring-ocean-400/30"
      : "bg-sand-200 text-clay-600 ring-clay-400/30";

  const canAddMore = person.protocols.length < MAX_PROTOCOLS_PER_PERSON;

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
              Person {index + 1}
            </h3>
            <p className="text-xs text-forest-800/55">
              Name + calendar, plus one or more protocols
            </p>
          </div>
        </div>
        {isComplete && (
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

      {/* Name + Schedule (per-person, single) */}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label text="Name" />
          <input
            type="text"
            value={person.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={index === 0 ? "e.g. Sohini" : `Person ${index + 1}`}
            className="w-full rounded-xl border border-forest-700/15 bg-white/90 px-4 py-3 text-sm text-forest-900 outline-none transition placeholder:text-forest-900/35 focus:border-moss-500 focus:ring-4 focus:ring-moss-400/20"
          />
        </div>
        <div>
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

      {/* Protocols (1..N) */}
      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <Label text={`Lab Protocols (${person.protocols.length})`} />
          <span className="text-[10px] uppercase tracking-[0.18em] text-forest-800/45">
            up to {MAX_PROTOCOLS_PER_PERSON}
          </span>
        </div>

        <div className="space-y-3">
          {person.protocols.map((entry, protoIdx) => (
            <ProtocolRow
              key={protoIdx}
              index={protoIdx}
              entry={entry}
              canRemove={person.protocols.length > 1}
              onChange={(patch) => onProtocolChange(protoIdx, patch)}
              onRemove={() => onRemoveProtocol(protoIdx)}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={onAddProtocol}
          disabled={!canAddMore}
          className="mt-3 inline-flex items-center gap-2 rounded-full border border-dashed border-forest-700/30 bg-white/60 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-forest-800/75 transition enabled:hover:border-moss-500 enabled:hover:bg-moss-50 enabled:hover:text-moss-700 disabled:cursor-not-allowed disabled:opacity-40"
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
          {canAddMore
            ? "Add another protocol"
            : `Max ${MAX_PROTOCOLS_PER_PERSON} protocols`}
        </button>
      </div>
    </div>
  );
}

/* ---------- Single protocol row (file + sample count + remove) ---------- */
function ProtocolRow({
  index,
  entry,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  entry: ProtocolEntry;
  canRemove: boolean;
  onChange: (patch: Partial<ProtocolEntry>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-xl border border-forest-700/10 bg-white/70 p-3 md:p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-forest-800/65">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-forest-700/10 text-[10px] font-bold text-forest-800">
            {index + 1}
          </span>
          Protocol {index + 1}
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-[11px] text-clay-500 hover:text-clay-700"
            aria-label={`Remove protocol ${index + 1}`}
          >
            remove
          </button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
        <FileDropSlot
          accept=".pdf,.doc,.docx,.txt,.md"
          file={entry.protocol}
          onChange={(f) => onChange({ protocol: f })}
          accent="moss"
          placeholder="Drop protocol or click"
        />
        <input
          type="text"
          inputMode="numeric"
          value={entry.sampleCount}
          onChange={(e) => onChange({ sampleCount: e.target.value })}
          placeholder="# of samples"
          aria-label={`Sample count for protocol ${index + 1}`}
          className="w-full rounded-xl border border-forest-700/15 bg-white/90 px-4 py-3 text-sm text-forest-900 outline-none transition placeholder:text-forest-900/35 focus:border-moss-500 focus:ring-4 focus:ring-moss-400/20"
        />
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
        file
          ? filledCls
          : `border-forest-700/15 bg-white/70 ${accentCls}`
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

function parsePositiveInt(s: string, fallback: number): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function synthTaskId(personName: string, protocolName: string, idx: number): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${slug(personName) || "person"}__${slug(protocolName)}__${idx + 1}`;
}
