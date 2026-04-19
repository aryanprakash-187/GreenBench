"use client";

import { useMemo, useState } from "react";

import type { Submission, SubmissionPersonInput } from "@/components/ResultsView";
import { SectionCard } from "@/app/results/tabs/PlanTab";
import { buildPersonIcs, suggestIcsFilename } from "@/lib/export/ics";
import type { NarratedWeekPlanResult, ScheduledTask } from "@/lib/engine/types";

type DownloadVia = "client" | "api";

const PERSON_BADGES = [
  "bg-moss-100 text-moss-700",
  "bg-ocean-100 text-ocean-700",
  "bg-sand-200 text-clay-600",
] as const;

export default function ExportTab({ data }: { data: Submission }) {
  const plan = data.plan;
  const [downloadVia, setDownloadVia] = useState<DownloadVia>("client");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Derive which people will appear in the download grid: any person from the
  // input AND any person mentioned by the engine schedule (in case names
  // diverge — they shouldn't, but we'd rather show too many than too few).
  const people = useMemo(() => {
    const seen = new Map<string, SubmissionPersonInput | null>();
    for (const p of data.people) {
      if (p.name?.trim()) seen.set(p.name.trim(), p);
    }
    for (const s of plan.schedule) {
      if (!seen.has(s.person)) seen.set(s.person, null);
    }
    return Array.from(seen.entries()).map(([name, person], i) => ({
      name,
      person,
      badge: PERSON_BADGES[i % PERSON_BADGES.length],
    }));
  }, [data.people, plan.schedule]);

  async function handleDownload(personName: string, busyIcsText: string | null) {
    setError(null);
    setWorking(personName);
    try {
      let icsText: string;
      if (downloadVia === "api") {
        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            person_name: personName,
            plan,
            busy_ics_text: busyIcsText ?? "",
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Server returned ${res.status}: ${body.slice(0, 200)}`);
        }
        icsText = await res.text();
      } else {
        icsText = buildPersonIcs({
          personName,
          plan,
          busyIcsText: busyIcsText ?? "",
        });
      }

      triggerDownload(icsText, suggestIcsFilename(personName));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-8">
      <SectionCard
        eyebrow="Step 3 · Export"
        title="Per-person calendar downloads, ready to import"
        lede="Each file is that person&rsquo;s uploaded busy calendar — passed through verbatim — plus the new protocol events and any shared coordination blocks they participate in. Import into Google Calendar, Apple Calendar, or Outlook."
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="text-forest-800/55">
            Built from {plan.schedule.length} scheduled task
            {plan.schedule.length === 1 ? "" : "s"} and{" "}
            {plan.coordinations.length} coordination
            {plan.coordinations.length === 1 ? "" : "s"}.
          </div>
          <SourceToggle value={downloadVia} onChange={setDownloadVia} />
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-clay-400/30 bg-clay-400/10 px-4 py-3 text-sm text-clay-700">
            {error}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          {people.map(({ name, person, badge }) => {
            const personEvents = describePersonEvents(name, plan);
            const isWorking = working === name;
            return (
              <div
                key={name}
                className="flex flex-col rounded-2xl border border-forest-700/10 bg-white/80 p-5 shadow-soft transition hover:shadow-lg"
              >
                <div className="mb-4 flex items-center gap-3">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-xl ${badge}`}
                  >
                    <CalIcon />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-forest-800/55">
                      Operator
                    </p>
                    <p className="truncate font-display text-lg font-semibold text-forest-800">
                      {name || "(unnamed)"}
                    </p>
                  </div>
                </div>

                <ul className="mb-5 space-y-2 text-xs">
                  {personEvents.length === 0 ? (
                    <li className="rounded-lg bg-forest-700/5 px-3 py-2 italic text-forest-800/55">
                      No events for this person — only the original calendar
                      passes through.
                    </li>
                  ) : (
                    personEvents.map((ev) => (
                      <li
                        key={ev.key}
                        className="flex items-start gap-2 rounded-lg bg-forest-700/5 px-3 py-2"
                      >
                        <span
                          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ev.dot}`}
                          style={
                            ev.shared
                              ? {
                                  backgroundImage:
                                    "repeating-linear-gradient(45deg, rgba(0,0,0,0.25) 0 3px, transparent 3px 6px)",
                                }
                              : undefined
                          }
                        />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-forest-800">
                            {ev.title}
                          </p>
                          <p className="text-forest-800/60">{ev.time}</p>
                        </div>
                      </li>
                    ))
                  )}
                </ul>

                <button
                  onClick={() =>
                    handleDownload(name, person?.schedule_ics_text ?? null)
                  }
                  disabled={isWorking}
                  className="mt-auto inline-flex items-center justify-center gap-2 rounded-full bg-forest-700 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-sand-50 transition enabled:hover:bg-forest-800 disabled:cursor-wait disabled:opacity-60"
                >
                  {isWorking ? (
                    <>
                      <SpinnerSmall />
                      Building…
                    </>
                  ) : (
                    <>
                      <DownloadIcon />
                      Download .ics
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <PreviewSection plan={plan} people={data.people} />
    </div>
  );
}

/* ---------- Preview ---------- */

function PreviewSection({
  plan,
  people,
}: {
  plan: NarratedWeekPlanResult;
  people: SubmissionPersonInput[];
}) {
  // Pick the first person who has anything to show; the preview is best-effort.
  const previewName =
    people.find((p) => p.protocols.length > 0)?.name?.trim() ||
    plan.schedule[0]?.person ||
    "Person 1";
  const events = describePersonEvents(previewName, plan).slice(0, 6);

  return (
    <SectionCard
      eyebrow="Preview"
      title={`What ${previewName}&rsquo;s calendar will look like`}
      lede="Original events are preserved verbatim. New events are colored by type — solid for individual tasks, striped for shared coordination events that appear on multiple calendars."
    >
      {events.length === 0 ? (
        <p className="text-sm italic text-forest-800/55">
          No engine-generated events for {previewName}; the download will
          contain only the original calendar.
        </p>
      ) : (
        <div className="space-y-3">
          {events.map((ev) => (
            <CalendarRow key={ev.key} row={ev} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function CalendarRow({ row }: { row: PersonEventRow }) {
  const { title, time, tone, shared } = row;
  const bg =
    tone === "moss"
      ? "bg-moss-100/70 text-moss-700 border-moss-500/30"
      : tone === "ocean"
      ? "bg-ocean-100/80 text-ocean-700 border-ocean-400/30"
      : "bg-sand-100 text-clay-600 border-clay-400/30";
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 ${bg}`}
      style={
        shared
          ? {
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(255,255,255,0.35) 0 8px, transparent 8px 16px)",
            }
          : undefined
      }
    >
      <div className="min-w-0">
        <p className="truncate font-semibold">{title}</p>
        {shared && (
          <p className="text-[10px] uppercase tracking-[0.18em] opacity-70">
            Shared coordination event
          </p>
        )}
      </div>
      <p className="shrink-0 text-xs opacity-80">{time}</p>
    </div>
  );
}

/* ---------- Source toggle ---------- */

function SourceToggle({
  value,
  onChange,
}: {
  value: DownloadVia;
  onChange: (v: DownloadVia) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-forest-700/15 bg-white/60 p-1 text-[10px] uppercase tracking-[0.18em] text-forest-800/65">
      <button
        onClick={() => onChange("client")}
        className={`rounded-full px-3 py-1 transition ${
          value === "client"
            ? "bg-forest-700 text-sand-50"
            : "hover:text-forest-800"
        }`}
      >
        in-browser
      </button>
      <button
        onClick={() => onChange("api")}
        className={`rounded-full px-3 py-1 transition ${
          value === "api"
            ? "bg-forest-700 text-sand-50"
            : "hover:text-forest-800"
        }`}
      >
        via API
      </button>
    </div>
  );
}

/* ---------- helpers ---------- */

interface PersonEventRow {
  key: string;
  title: string;
  time: string;
  dot: string;
  tone: "moss" | "ocean" | "sand";
  shared: boolean;
}

const FAMILY_TONES: Record<string, "moss" | "ocean" | "sand"> = {
  DNA_extraction: "moss",
  PCR: "ocean",
  Bead_cleanup: "sand",
};

const FAMILY_DOTS: Record<string, string> = {
  DNA_extraction: "bg-moss-500",
  PCR: "bg-ocean-400",
  Bead_cleanup: "bg-clay-500",
};

function describePersonEvents(
  personName: string,
  plan: NarratedWeekPlanResult
): PersonEventRow[] {
  const rows: PersonEventRow[] = [];
  const tasks = plan.schedule
    .filter((s) => s.person === personName)
    .sort((a, b) => a.start_iso.localeCompare(b.start_iso));

  for (const t of tasks) {
    rows.push({
      key: `task__${t.task_id}`,
      title: t.protocol_name,
      time: formatRelativeDateTime(t.start_iso, t.end_iso),
      dot: FAMILY_DOTS[t.family] ?? "bg-sand-200",
      tone: FAMILY_TONES[t.family] ?? "sand",
      shared: t.shared_with.length > 0,
    });
  }

  // Shared coordination events the person participates in.
  for (const c of plan.coordinations) {
    const part = c.participants.find((p) => p.person === personName);
    if (!part) continue;
    const peerTask = plan.schedule.find(
      (s) => s.task_id === part.task_id
    );
    if (!peerTask) continue;
    const others = uniq(
      c.participants.map((p) => p.person).filter((n) => n !== personName)
    );
    rows.push({
      key: `coord__${c.id}__${personName}`,
      title:
        c.type === "shared_reagent_prep"
          ? `Shared prep — ${humanize(c.overlap_group ?? "reagent")}${
              others.length ? ` (with ${others.join(", ")})` : ""
            }`
          : `Shared run — ${humanize(c.equipment_group ?? "equipment")}${
              others.length ? ` (with ${others.join(", ")})` : ""
            }`,
      time: formatRelativeDateTime(peerTask.start_iso, peerTask.end_iso),
      dot: c.type === "shared_reagent_prep" ? "bg-moss-500" : "bg-ocean-400",
      tone: c.type === "shared_reagent_prep" ? "moss" : "ocean",
      shared: true,
    });
  }

  return rows;
}

function formatRelativeDateTime(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const dow = start.toLocaleDateString(undefined, { weekday: "short" });
  const startTime = start.toISOString().slice(11, 16);
  const endTime = end.toISOString().slice(11, 16);
  return `${dow} · ${startTime}–${endTime} UTC`;
}

function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function triggerDownload(text: string, filename: string): void {
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

/* ---------- icons ---------- */

function CalIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function SpinnerSmall() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
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
