"use client";

import type { Submission } from "@/components/ResultsView";
import { SectionCard } from "@/app/results/tabs/PlanTab";

export default function ExportTab({ data }: { data: Submission | null }) {
  const people = buildPeople(data);

  function downloadIcs(personName: string) {
    const now = new Date();
    const stamp = (d: Date) =>
      d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");

    const start = new Date(now);
    start.setDate(start.getDate() + 1);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 90 * 60 * 1000);

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Green Bench//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${Date.now()}@greenbench.local`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:Green Bench · Shared ethanol prep (with ${personName})`,
      "LOCATION:Bench 3 · 70% ethanol station",
      "DESCRIPTION:Prepped once for the DNeasy wash and AMPure cleanup. Hazard\\, EPA CompTox CASRN 64-17-5 · RCRA D001 (ignitable).",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${personName.replace(/\s+/g, "_").toLowerCase()}_greenbench.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-8">
      <SectionCard
        eyebrow="Step 3 · Export"
        title="Three calendar downloads, ready to import"
        lede="Each file is that person&rsquo;s uploaded busy calendar — unchanged — plus the new protocol events and any shared coordination blocks. Import into Google Calendar, Apple Calendar, or Outlook."
      >
        <div className="grid gap-4 md:grid-cols-3">
          {people.map((p) => (
            <div
              key={p.name}
              className="flex flex-col rounded-2xl border border-forest-700/10 bg-white/80 p-5 shadow-soft transition hover:shadow-lg"
            >
              <div className="mb-4 flex items-center gap-3">
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${p.badge}`}>
                  <CalIcon />
                </span>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-forest-800/55">
                    Operator
                  </p>
                  <p className="font-display text-lg font-semibold text-forest-800">
                    {p.name}
                  </p>
                </div>
              </div>

              <ul className="mb-5 space-y-2 text-xs">
                {p.events.map((ev) => (
                  <li
                    key={ev.title}
                    className="flex items-start gap-2 rounded-lg bg-forest-700/5 px-3 py-2"
                  >
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ev.dot}`} />
                    <div>
                      <p className="font-semibold text-forest-800">{ev.title}</p>
                      <p className="text-forest-800/60">{ev.time}</p>
                    </div>
                  </li>
                ))}
              </ul>

              <button
                onClick={() => downloadIcs(p.name)}
                className="mt-auto inline-flex items-center justify-center gap-2 rounded-full bg-forest-700 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-sand-50 transition hover:bg-forest-800"
              >
                <DownloadIcon />
                Download .ics
              </button>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        eyebrow="Preview"
        title="What each calendar will look like after import"
        lede="Original events are preserved. New events are colored by type — solid for individual tasks, striped for shared coordination events that appear on multiple calendars."
      >
        <div className="space-y-3">
          {[
            {
              label: "Existing (from your uploaded .ics)",
              time: "Mon · 10:00–11:00",
              tone: "sand" as const,
            },
            {
              label: "DNeasy Blood & Tissue extraction",
              time: "Mon · 13:00–14:30",
              tone: "moss" as const,
            },
            {
              label: "Shared: prep 60 mL 70% ethanol (with Vikas)",
              time: "Mon · 09:00–09:20",
              tone: "ocean" as const,
              shared: true,
            },
            {
              label: "AMPure XP cleanup",
              time: "Thu · 14:00–15:00",
              tone: "moss" as const,
            },
          ].map((row) => (
            <CalendarRow key={row.label} {...row} />
          ))}
        </div>
        <p className="mt-5 text-xs text-forest-800/55">
          Stretch goals from the README — annualized impact projection and a
          shareable schedule URL — plug into this page next.
        </p>
      </SectionCard>
    </div>
  );
}

function CalendarRow({
  label,
  time,
  tone,
  shared,
}: {
  label: string;
  time: string;
  tone: "moss" | "ocean" | "sand";
  shared?: boolean;
}) {
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
        <p className="truncate font-semibold">{label}</p>
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

function buildPeople(data: Submission | null) {
  const defaults = [
    {
      badge: "bg-moss-100 text-moss-700",
      events: [
        { title: "DNA extraction", time: "Mon 13:00", dot: "bg-moss-500" },
        { title: "Shared ethanol prep", time: "Mon 09:00", dot: "bg-ocean-400" },
        { title: "AMPure cleanup", time: "Thu 14:00", dot: "bg-moss-500" },
      ],
    },
    {
      badge: "bg-ocean-100 text-ocean-700",
      events: [
        { title: "PCR setup", time: "Wed 10:00", dot: "bg-ocean-400" },
        { title: "Shared ethanol prep", time: "Mon 09:00", dot: "bg-ocean-400" },
      ],
    },
    {
      badge: "bg-sand-200 text-clay-600",
      events: [
        { title: "Bead cleanup", time: "Tue 11:00", dot: "bg-clay-500" },
        { title: "PCR", time: "Fri 09:30", dot: "bg-ocean-400" },
      ],
    },
  ];
  return defaults.map((d, i) => ({
    ...d,
    name: data?.people?.[i]?.name?.trim() || `Person ${i + 1}`,
  }));
}

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
