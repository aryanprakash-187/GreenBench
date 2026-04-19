"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopBar, Footer } from "@/components/OverviewPage";
import {
  loadSubmission,
  hasPlan,
  type Submission,
  type SubmissionPersonInput,
} from "@/lib/submission";
import { buildPersonIcs, suggestIcsFilename } from "@/lib/export/ics";
import type {
  NarratedCoordination,
  NarratedWeekPlanResult,
  ScheduledTask,
} from "@/lib/engine/types";

// Mirrors the ICS exporter — see lib/export/ics.ts for rationale. Multiple
// shared reagent preps that anchor to the same task are nested back-to-back
// (DURATION + GAP minutes apart) instead of stacked at one slot.
const SHARED_PREP_LEAD_MIN = 30;
const SHARED_PREP_DEFAULT_DURATION_MIN = 20;
const SHARED_PREP_STAGGER_GAP_MIN = 5;

type SchedulesPageProps = {
  onBack?: () => void;
};

const ACCENTS = ["moss", "ocean", "sand"] as const;
type Accent = (typeof ACCENTS)[number];

type PreviewEvent = {
  key: string;
  title: string;
  day: string;
  start: string;
  end: string;
  durationMin: number;
  tone: "moss" | "ocean" | "sand";
  location: string;
  description: string;
  shared: boolean;
};

const FAMILY_TONES: Record<string, "moss" | "ocean" | "sand"> = {
  DNA_extraction: "moss",
  PCR: "ocean",
  Bead_cleanup: "sand",
};

export default function SchedulesPage({ onBack }: SchedulesPageProps = {}) {
  const router = useRouter();
  const [data, setData] = useState<Submission | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "missing">(
    "loading",
  );
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sub = loadSubmission();
    if (sub && hasPlan(sub)) {
      setData(sub);
      setLoadState("ok");
    } else {
      setLoadState("missing");
    }
  }, []);

  // Bounce direct/refresh visits without a submission back to step 1 after a
  // brief readable pause, so users aren't stranded on the MissingState card.
  useEffect(() => {
    if (loadState !== "missing") return;
    const t = window.setTimeout(() => router.replace("/"), 1500);
    return () => window.clearTimeout(t);
  }, [loadState, router]);

  const plan = data?.plan;
  const inputs = data?.inputs ?? [];

  const personRows = useMemo(() => {
    if (!plan) return [];
    return buildPersonRows(plan, inputs);
  }, [plan, inputs]);

  const joined =
    personRows.length === 0
      ? "your lab"
      : personRows.length === 1
      ? personRows[0].name
      : personRows.length === 2
      ? `${personRows[0].name} & ${personRows[1].name}`
      : `${personRows
          .slice(0, -1)
          .map((p) => p.name)
          .join(", ")} & ${personRows[personRows.length - 1].name}`;

  async function handleDownload(name: string, busyIcs: string | null) {
    if (!plan) return;
    setError(null);
    setWorking(name);
    try {
      const ics = buildPersonIcs({
        personName: name,
        plan,
        busyIcsText: busyIcs ?? "",
      });
      triggerDownload(ics, suggestIcsFilename(name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="min-h-screen bg-white text-forest-900">
      <TopBar onBack={onBack} />

      {/* Centered title hero */}
      <section className="border-b border-forest-700/10 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-16 text-center md:py-24">
          <p className="mb-3 text-[11px] uppercase tracking-[0.3em] text-forest-800/55">
            Step 3 · Export
          </p>
          <h1 className="font-brand text-[clamp(3rem,8vw,6rem)] font-medium leading-none tracking-[0.01em] text-forest-800">
            Finalized Schedules
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-forest-800/70 md:text-base">
            One calendar file per person — {joined}. Each preserves the events
            from the schedule you uploaded and adds new protocol and
            shared-prep events scheduled in mutually-free windows. Import into
            Google Calendar, Apple Calendar, or Outlook.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-12">
        {loadState === "loading" && (
          <div className="rounded-3xl border border-forest-700/10 bg-white/70 p-12 text-center text-sm text-forest-800/60 shadow-soft">
            Loading your schedule…
          </div>
        )}
        {loadState === "missing" && <MissingState />}

        {error && (
          <div className="rounded-2xl border border-clay-400/30 bg-clay-400/10 px-4 py-3 text-sm text-clay-700">
            {error}
          </div>
        )}

        {loadState === "ok" &&
          personRows.map((row, i) => (
            <PersonScheduleCard
              key={row.name}
              index={i}
              row={row}
              isWorking={working === row.name}
              onDownload={() => handleDownload(row.name, row.busyIcsText)}
            />
          ))}

        {loadState === "ok" && personRows.length > 0 && (
          <p className="pt-2 text-center text-xs text-forest-800/55">
            Events added by Green Bench preserve every original VEVENT from
            your uploaded calendar; new events are tagged in the description
            so they&rsquo;re easy to spot.
          </p>
        )}
      </main>

      <Footer />
    </div>
  );
}

/* ---------- Missing state ---------- */

function MissingState() {
  return (
    <div className="rounded-3xl border border-clay-400/30 bg-clay-400/10 p-10 text-center shadow-soft">
      <p className="text-[10px] uppercase tracking-[0.25em] text-clay-700">
        No plan in this browser
      </p>
      <h3 className="mt-2 font-display text-2xl font-semibold text-clay-700">
        We couldn&rsquo;t find a saved schedule.
      </h3>
      <p className="mx-auto mt-3 max-w-md text-sm text-clay-700/85">
        Submit step 1 first — we keep everything in your browser, so an
        incognito tab or a cleared cache will look like this.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex rounded-full bg-forest-700 px-6 py-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-sand-50 transition hover:bg-forest-800"
      >
        Start a plan
      </Link>
    </div>
  );
}

/* ---------- Per-person card ---------- */

function PersonScheduleCard({
  index,
  row,
  isWorking,
  onDownload,
}: {
  index: number;
  row: PersonRow;
  isWorking: boolean;
  onDownload: () => void;
}) {
  const accent: Accent = ACCENTS[index % ACCENTS.length];
  const badge =
    accent === "moss"
      ? "bg-moss-100 text-moss-700"
      : accent === "ocean"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-200 text-clay-600";

  return (
    <section className="overflow-hidden rounded-3xl border border-sand-50/10 bg-forest-800/70 shadow-soft">
      {/* Card header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-sand-50/10 bg-forest-700/60 px-6 py-5 md:px-8">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-xl font-display text-base font-semibold ${badge}`}
          >
            {index + 1}
          </span>
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-sand-100/60">
              Person {index + 1}
            </p>
            <h2 className="font-display text-2xl font-semibold text-sand-50">
              {row.name}
            </h2>
            <p className="text-[11px] text-sand-100/55">
              {row.engineEvents} new event
              {row.engineEvents === 1 ? "" : "s"}
              {row.passthroughCount > 0 &&
                ` · ${row.passthroughCount} original event${
                  row.passthroughCount === 1 ? "" : "s"
                } passed through`}
            </p>
          </div>
        </div>

        <DownloadButton
          isWorking={isWorking}
          onClick={onDownload}
        />
      </div>

      {/* Preview list */}
      <div className="px-6 py-6 md:px-8">
        <p className="mb-4 text-[10px] uppercase tracking-[0.2em] text-sand-100/60">
          Calendar preview · {row.events.length} new event
          {row.events.length === 1 ? "" : "s"}
        </p>
        {row.events.length === 0 ? (
          <p className="rounded-xl bg-forest-900/40 px-4 py-4 text-sm italic text-sand-100/65">
            The engine didn&rsquo;t schedule any new events for this person —
            the download will contain only the original calendar.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {row.events.map((ev) => (
              <EventRow key={ev.key} event={ev} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function EventRow({ event }: { event: PreviewEvent }) {
  const bg =
    event.tone === "moss"
      ? "bg-moss-100/70 text-moss-700 border-moss-500/30"
      : event.tone === "ocean"
      ? "bg-ocean-100/70 text-ocean-700 border-ocean-400/30"
      : "bg-sand-100 text-clay-600 border-clay-400/30";

  return (
    <li
      className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 ${bg}`}
      style={
        event.shared
          ? {
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(255,255,255,0.35) 0 8px, transparent 8px 16px)",
            }
          : undefined
      }
    >
      <div className="min-w-0">
        <p className="truncate font-semibold">{event.title}</p>
        <p className="truncate text-[11px] opacity-75">
          {event.location}
          {event.shared && (
            <span className="ml-2 rounded-full bg-white/50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.15em]">
              Shared
            </span>
          )}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-semibold">
          {event.day} · {event.start}
        </p>
        <p className="text-[11px] opacity-75">{event.durationMin} min</p>
      </div>
    </li>
  );
}

function DownloadButton({
  isWorking,
  onClick,
}: {
  isWorking: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={isWorking}
      className="spin-light group inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-black shadow-soft transition hover:bg-sand-100 active:translate-y-px disabled:cursor-wait disabled:opacity-70"
    >
      {isWorking ? (
        <>
          <Spinner />
          Building…
        </>
      ) : (
        <>
          <svg
            className="h-4 w-4 transition group-hover:translate-y-0.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
          Download .ics
        </>
      )}
    </button>
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

/* ---------- Row builders ---------- */

type PersonRow = {
  name: string;
  busyIcsText: string | null;
  events: PreviewEvent[];
  engineEvents: number;
  passthroughCount: number;
};

function buildPersonRows(
  plan: NarratedWeekPlanResult,
  inputs: SubmissionPersonInput[],
): PersonRow[] {
  // Union of input names + people the engine actually scheduled.
  const seen = new Map<string, SubmissionPersonInput | null>();
  for (const p of inputs) {
    if (p.name?.trim()) seen.set(p.name.trim(), p);
  }
  for (const s of plan.schedule) {
    if (!seen.has(s.person)) seen.set(s.person, null);
  }

  return Array.from(seen.entries()).map(([name, input]) => {
    const events = describePersonEvents(name, plan);
    return {
      name,
      busyIcsText: input?.schedule_ics_text ?? null,
      events,
      engineEvents: events.length,
      passthroughCount: countPassthroughEvents(input?.schedule_ics_text ?? ""),
    };
  });
}

function describePersonEvents(
  personName: string,
  plan: NarratedWeekPlanResult,
): PreviewEvent[] {
  const rows: PreviewEvent[] = [];

  const tasks = plan.schedule
    .filter((s) => s.person === personName)
    .sort((a, b) => a.start_iso.localeCompare(b.start_iso));

  for (const t of tasks) {
    const tone = FAMILY_TONES[t.family] ?? "sand";
    const start = new Date(t.start_iso);
    const end = new Date(t.end_iso);
    const equipment = t.equipment
      .map((e) => e.lab_id ?? e.equipment_group)
      .filter(Boolean)
      .join(" · ");

    // Resolve the other participants of every coordination this task is
    // part of back to *person names*. t.shared_with stores opaque task_ids,
    // which aren't useful to the viewer — but plan.coordinations has the
    // participant list with person names we can surface instead.
    const peers = uniq(
      plan.coordinations
        .filter((c) => c.participants.some((p) => p.task_id === t.task_id))
        .flatMap((c) => c.participants.map((p) => p.person))
        .filter((n) => n !== personName),
    );

    const baseLocation = equipment || "Lab bench";
    const location =
      peers.length > 0 ? `${baseLocation} · with ${peers.join(", ")}` : baseLocation;

    rows.push({
      key: `task__${t.task_id}`,
      title: t.protocol_name,
      day: start.toLocaleDateString(undefined, { weekday: "short" }),
      start: formatLocalHm(start),
      end: formatLocalHm(end),
      durationMin: Math.max(
        0,
        Math.round((end.getTime() - start.getTime()) / 60000),
      ),
      tone,
      location,
      description:
        peers.length > 0
          ? `${t.protocol_name} for ${personName}. Shared with ${peers.join(", ")}.`
          : `${t.protocol_name} for ${personName}.`,
      shared: peers.length > 0 || t.shared_with.length > 0,
    });
  }

  // Shared *reagent prep* coordinations only — see lib/export/ics.ts for
  // why shared_equipment_run is excluded (each participant already owns a
  // task event at that time with the equipment in its location). We also
  // drop coordinations with no real net savings (e.g. equipment shares
  // clamped to runs_saved=0 by capacity math). Multiple preps anchored to
  // the same task are staggered back-to-back so a single human can
  // realistically execute them sequentially instead of all at once.
  type PrepEntry = { coord: NarratedCoordination; anchorMs: number };
  const prepBuckets = new Map<number, PrepEntry[]>();
  for (const c of plan.coordinations) {
    if (!c.participants.some((p) => p.person === personName)) continue;
    if (c.type !== "shared_reagent_prep") continue;
    if (!coordinationHasNonzeroSavings(c)) continue;
    const partTask = plan.schedule.find((s) =>
      c.participants.some((p) => p.task_id === s.task_id),
    );
    if (!partTask) continue;
    const anchorMs = c.participants
      .map((p) => plan.schedule.find((s) => s.task_id === p.task_id))
      .filter((s): s is ScheduledTask => !!s)
      .reduce(
        (min, s) => Math.min(min, new Date(s.start_iso).getTime()),
        Number.POSITIVE_INFINITY,
      );
    if (!Number.isFinite(anchorMs)) continue;
    const list = prepBuckets.get(anchorMs) ?? [];
    list.push({ coord: c, anchorMs });
    prepBuckets.set(anchorMs, list);
  }

  for (const entries of prepBuckets.values()) {
    entries.sort((a, b) => a.coord.id.localeCompare(b.coord.id));
    for (let i = 0; i < entries.length; i++) {
      const { coord, anchorMs } = entries[i];
      const startOffsetMin =
        SHARED_PREP_LEAD_MIN +
        SHARED_PREP_DEFAULT_DURATION_MIN +
        i * (SHARED_PREP_DEFAULT_DURATION_MIN + SHARED_PREP_STAGGER_GAP_MIN);
      const start = new Date(anchorMs - startOffsetMin * 60 * 1000);
      const end = new Date(
        start.getTime() + SHARED_PREP_DEFAULT_DURATION_MIN * 60 * 1000,
      );
      const others = uniq(
        coord.participants
          .map((p) => p.person)
          .filter((n) => n !== personName),
      );
      const groupLabel = humanize(coord.overlap_group ?? "reagent");
      rows.push({
        key: `coord__${coord.id}__${personName}`,
        title: `Shared prep — ${groupLabel}`,
        day: start.toLocaleDateString(undefined, { weekday: "short" }),
        start: formatLocalHm(start),
        end: formatLocalHm(end),
        durationMin: SHARED_PREP_DEFAULT_DURATION_MIN,
        tone: "moss",
        location: others.length > 0 ? `with ${others.join(", ")}` : "shared",
        description: coord.recommendation,
        shared: true,
      });
    }
  }

  return rows;
}

function coordinationHasNonzeroSavings(c: NarratedCoordination): boolean {
  const s = c.savings;
  if ((s.runs_saved ?? 0) > 0) return true;
  if ((s.prep_events_saved ?? 0) > 0) return true;
  if ((s.volume_ml ?? 0) > 0) return true;
  if ((s.hazardous_disposal_events_avoided ?? 0) > 0) return true;
  if (s.co2e_kg_range && (s.co2e_kg_range[0] > 0 || s.co2e_kg_range[1] > 0))
    return true;
  return false;
}

function countPassthroughEvents(ics: string): number {
  if (!ics) return 0;
  const matches = ics.match(/\bBEGIN:VEVENT\b/g);
  return matches ? matches.length : 0;
}

/* ---------- helpers ---------- */

function formatLocalHm(d: Date): string {
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function triggerDownload(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
