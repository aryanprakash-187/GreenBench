"use client";

import { useEffect, useState } from "react";
import { TopBar, Footer } from "@/components/OverviewPage";
import {
  loadSubmission,
  namesList,
  type Submission,
} from "@/lib/submission";

type ScheduleEvent = {
  title: string;
  day: string;
  start: string; // "HH:MM"
  durationMin: number;
  tone: "moss" | "ocean" | "sand";
  location: string;
  description: string;
  shared?: boolean;
};

type PersonSchedule = {
  name: string;
  accent: "moss" | "ocean" | "sand";
  events: ScheduleEvent[];
};

type SchedulesPageProps = {
  onBack?: () => void;
};

export default function SchedulesPage({ onBack }: SchedulesPageProps = {}) {
  const [data, setData] = useState<Submission | null>(null);

  useEffect(() => {
    setData(loadSubmission());
  }, []);

  const names = namesList(data);
  const joined =
    names.length === 0
      ? "your lab"
      : names.length === 1
      ? names[0]
      : names.length === 2
      ? `${names[0]} & ${names[1]}`
      : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;

  const schedules = buildSchedules(data);

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
            Three calendar files — one per person. Each file preserves the
            events from the schedule you uploaded and adds new protocol and
            shared-prep events scheduled in mutually-free windows. Import into
            Google Calendar, Apple Calendar, or Outlook.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-12">
        {schedules.map((s, i) => (
          <PersonScheduleCard key={i} index={i} schedule={s} />
        ))}

        <p className="pt-2 text-center text-xs text-forest-800/55">
          Events added by Green Bench are marked with a leaf icon in each
          calendar app; your original events are untouched.
        </p>
      </main>

      <Footer />
    </div>
  );
}

function PersonScheduleCard({
  index,
  schedule,
}: {
  index: number;
  schedule: PersonSchedule;
}) {
  const badge =
    schedule.accent === "moss"
      ? "bg-moss-100 text-moss-700"
      : schedule.accent === "ocean"
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
              {schedule.name}
            </h2>
          </div>
        </div>

        <DownloadButton
          onClick={() => downloadPersonIcs(schedule)}
          filename={`${slug(schedule.name)}_greenbench.ics`}
        />
      </div>

      {/* Preview list */}
      <div className="px-6 py-6 md:px-8">
        <p className="mb-4 text-[10px] uppercase tracking-[0.2em] text-sand-100/60">
          Calendar preview · {schedule.events.length} event
          {schedule.events.length === 1 ? "" : "s"}
        </p>
        <ul className="space-y-2.5">
          {schedule.events.map((ev, i) => (
            <EventRow key={i} event={ev} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function EventRow({ event }: { event: ScheduleEvent }) {
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
  onClick,
  filename,
}: {
  onClick: () => void;
  filename: string;
}) {
  return (
    <button
      onClick={onClick}
      className="spin-light group inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-black shadow-soft transition hover:bg-sand-100 active:translate-y-px"
      aria-label={`Download ${filename}`}
    >
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
    </button>
  );
}

/* ---------- Data ---------- */

function buildSchedules(data: Submission | null): PersonSchedule[] {
  const accents: PersonSchedule["accent"][] = ["moss", "ocean", "sand"];

  const presets: PersonSchedule[] = [
    {
      name: "Person 1",
      accent: "moss",
      events: [
        {
          title: "Existing: Lab meeting",
          day: "Mon",
          start: "10:00",
          durationMin: 60,
          tone: "sand",
          location: "From your uploaded .ics",
          description: "Original calendar event preserved unchanged.",
        },
        {
          title: "Shared: Prep 60 mL 70% ethanol",
          day: "Mon",
          start: "09:00",
          durationMin: 20,
          tone: "ocean",
          location: "Bench 3 · ethanol station",
          description:
            "Shared-prep event covering DNeasy, MagJET, and AMPure washes.",
          shared: true,
        },
        {
          title: "DNeasy Blood & Tissue extraction",
          day: "Mon",
          start: "13:00",
          durationMin: 90,
          tone: "moss",
          location: "Bench 3 · microcentrifuge Eppendorf 5424",
          description: "8 samples. Dependency: none.",
        },
        {
          title: "AMPure XP cleanup",
          day: "Thu",
          start: "14:00",
          durationMin: 45,
          tone: "moss",
          location: "Bench 2 · magnetic plate Ambion-96",
          description: "After PCR completes.",
        },
      ],
    },
    {
      name: "Person 2",
      accent: "ocean",
      events: [
        {
          title: "Existing: Office hours",
          day: "Tue",
          start: "14:00",
          durationMin: 60,
          tone: "sand",
          location: "From your uploaded .ics",
          description: "Original calendar event preserved unchanged.",
        },
        {
          title: "Shared: Prep 60 mL 70% ethanol",
          day: "Mon",
          start: "09:00",
          durationMin: 20,
          tone: "ocean",
          location: "Bench 3 · ethanol station",
          description: "Shared with Person 1. Same window free for both.",
          shared: true,
        },
        {
          title: "Q5 Hot Start PCR",
          day: "Wed",
          start: "10:00",
          durationMin: 120,
          tone: "ocean",
          location: "Thermocycler C1000-A",
          description: "12 reactions. Batched with Person 3's PCR.",
        },
      ],
    },
    {
      name: "Person 3",
      accent: "sand",
      events: [
        {
          title: "Existing: Class TA",
          day: "Thu",
          start: "09:00",
          durationMin: 90,
          tone: "sand",
          location: "From your uploaded .ics",
          description: "Original calendar event preserved unchanged.",
        },
        {
          title: "Bead cleanup",
          day: "Tue",
          start: "11:00",
          durationMin: 60,
          tone: "sand",
          location: "Bench 2 · magnetic plate Ambion-96",
          description: "6 samples.",
        },
        {
          title: "PCR (batched with Person 2)",
          day: "Wed",
          start: "10:00",
          durationMin: 120,
          tone: "ocean",
          location: "Thermocycler C1000-A · wells 49–96",
          description:
            "Same annealing temperature (60 °C) and cycle count (30) — merged into a single block.",
          shared: true,
        },
      ],
    },
  ];

  return presets.map((p, i) => ({
    ...p,
    name: data?.people?.[i]?.name?.trim() || p.name,
    accent: accents[i],
  }));
}

/* ---------- ICS generation ---------- */

function downloadPersonIcs(schedule: PersonSchedule) {
  const now = new Date();
  // Monday of "next week" as demo anchor
  const anchor = new Date(now);
  const dow = anchor.getDay();
  const daysUntilMon = (8 - dow) % 7 || 7;
  anchor.setDate(anchor.getDate() + daysUntilMon);
  anchor.setHours(0, 0, 0, 0);

  const dayOffset: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };

  const events = schedule.events
    .map((ev, i) => {
      const offset = dayOffset[ev.day] ?? 0;
      const [hh, mm] = ev.start.split(":").map((n) => parseInt(n, 10));
      const start = new Date(anchor);
      start.setDate(start.getDate() + offset);
      start.setHours(hh, mm, 0, 0);
      const end = new Date(start.getTime() + ev.durationMin * 60 * 1000);
      const uid = `${Date.now()}-${i}-${slug(schedule.name)}@greenbench.local`;

      return [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${icsStamp(now)}`,
        `DTSTART:${icsStamp(start)}`,
        `DTEND:${icsStamp(end)}`,
        `SUMMARY:${icsEscape(
          ev.shared ? `🌱 ${ev.title} (shared)` : `🌱 ${ev.title}`
        )}`,
        `LOCATION:${icsEscape(ev.location)}`,
        `DESCRIPTION:${icsEscape(ev.description)}`,
        "END:VEVENT",
      ].join("\r\n");
    })
    .join("\r\n");

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Green Bench//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:Green Bench · ${schedule.name}`,
    events,
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(schedule.name)}_greenbench.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function icsStamp(d: Date) {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}
