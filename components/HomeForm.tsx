"use client";

import { useRef, useState } from "react";
import { Footer } from "@/components/OverviewPage";

type Person = {
  name: string;
  protocol: File | null;
  schedule: File | null;
  sampleCount: string;
};

const EMPTY_PERSON: Person = {
  name: "",
  protocol: null,
  schedule: null,
  sampleCount: "",
};

export default function HomeForm() {
  const [people, setPeople] = useState<Person[]>([
    { ...EMPTY_PERSON },
    { ...EMPTY_PERSON },
    { ...EMPTY_PERSON },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);

  function updatePerson(index: number, patch: Partial<Person>) {
    setPeople((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const payload = {
      people: people.map((p) => ({
        name: p.name.trim(),
        protocol: p.protocol
          ? { name: p.protocol.name, size: p.protocol.size }
          : null,
        schedule: p.schedule
          ? { name: p.schedule.name, size: p.schedule.size }
          : null,
        sampleCount: p.sampleCount.trim(),
      })),
      submittedAt: new Date().toISOString(),
    };

    try {
      // localStorage (not sessionStorage) so new tabs can read the data.
      localStorage.setItem("greenbench.submission", JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }

    // Submit / Resubmit only opens the Overview tab (Step 2). The Finalized
    // Schedules tab (Step 3) is opened from the Next button on the Overview
    // page, not here. This keeps the flow linear: Step 1 → Step 2 → Step 3.
    const overview = window.open("/overview", "_blank", "noopener,noreferrer");
    try {
      overview?.focus();
    } catch {
      // ignore: browser may refuse focus
    }

    if (!overview) {
      setPopupBlocked(true);
    }

    setLaunched(true);
    setSubmitting(false);
  }

  function reopenTabs() {
    const overview = window.open("/overview", "_blank", "noopener,noreferrer");
    try {
      overview?.focus();
    } catch {
      // ignore
    }
    if (overview) setPopupBlocked(false);
  }

  // Require every person to have all four fields filled out.
  const filledCount = people.filter(
    (p) =>
      p.name.trim() &&
      p.protocol &&
      p.schedule &&
      p.sampleCount.trim()
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

          <div className="mt-10 flex flex-col items-center justify-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="group inline-flex items-center gap-3 rounded-full bg-forest-700 px-10 py-4 text-sm font-semibold uppercase tracking-[0.2em] text-sand-50 shadow-soft transition enabled:hover:bg-forest-800 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>{launched ? "Resubmit" : "Submit"}</span>
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

          {/* Launched confirmation */}
          {launched && (
            <div className="mt-6 rounded-2xl border border-moss-500/30 bg-moss-50/80 p-5 text-center">
              {popupBlocked ? (
                <>
                  <p className="text-sm font-semibold text-forest-800">
                    Your browser blocked the Overview tab.
                  </p>
                  <p className="mt-1 text-xs text-forest-800/70">
                    Allow pop-ups for this site, or click below to open it
                    manually.
                  </p>
                  <button
                    type="button"
                    onClick={reopenTabs}
                    className="mt-3 inline-flex items-center gap-2 rounded-full bg-forest-700 px-5 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-sand-50 transition hover:bg-forest-800"
                  >
                    Open Overview
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-forest-800">
                    Overview opened in a new tab. Use the Next button there to
                    continue to Finalized Schedules.
                  </p>
                  <p className="mt-1 text-xs text-forest-800/70">
                    Didn&rsquo;t see it? Check that your browser allows pop-ups
                    from this site.
                  </p>
                  <button
                    type="button"
                    onClick={reopenTabs}
                    className="mt-3 inline-flex items-center gap-2 rounded-full border border-forest-700/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
                  >
                    Reopen Overview
                  </button>
                </>
              )}
            </div>
          )}
        </form>

        <p className="mt-8 text-center text-xs text-forest-800/50">
          Your files stay in your browser — Green Bench is stateless.
        </p>
      </div>

      <div className="relative z-10 mt-20">
        <Footer />
      </div>
    </section>
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
