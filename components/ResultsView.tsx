"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import PlanTab from "@/app/results/tabs/PlanTab";
import CoordinateTab from "@/app/results/tabs/CoordinateTab";
import ExportTab from "@/app/results/tabs/ExportTab";

type FileStub = { name: string; size: number } | null;
export type PersonStub = {
  name: string;
  protocol: FileStub;
  schedule: FileStub;
  sampleCount: string;
};
export type Submission = {
  people: PersonStub[];
  submittedAt: string;
};

const TABS = [
  { id: "plan", label: "Plan", blurb: "Parsed inputs and week outline" },
  { id: "coordinate", label: "Coordinate", blurb: "Impact, overlaps, warnings" },
  { id: "export", label: "Export", blurb: "Per-person .ics downloads" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function ResultsView() {
  const [tab, setTab] = useState<TabId>("plan");
  const [data, setData] = useState<Submission | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("greenbench.submission");
      if (raw) setData(JSON.parse(raw) as Submission);
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="min-h-screen bg-sand-50 text-forest-900">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-forest-700/10 bg-sand-50/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link
            href="/"
            className="group flex items-center gap-3"
            aria-label="Green Bench home"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-forest-700 text-sand-50">
              <LeafIcon />
            </span>
            <div className="leading-tight">
              <p className="font-brand text-xl font-semibold tracking-tight text-forest-800">
                Green Bench
              </p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-forest-800/55">
                schedule for sustainability
              </p>
            </div>
          </Link>

          <Link
            href="/"
            className="rounded-full border border-forest-700/20 px-4 py-1.5 text-xs font-medium uppercase tracking-[0.2em] text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
          >
            ← New plan
          </Link>
        </div>
      </header>

      {/* Summary banner */}
      <section className="border-b border-forest-700/10 bg-white/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-forest-800/55">
              Planning for
            </p>
            <h1 className="font-display text-2xl font-semibold text-forest-800 md:text-3xl">
              {(() => {
                const names =
                  data?.people
                    ?.map((p) => p.name)
                    .filter((n) => n && n.trim().length > 0) ?? [];
                if (names.length === 0) return "your lab";
                if (names.length === 1) return names[0];
                if (names.length === 2) return `${names[0]} & ${names[1]}`;
                return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
              })()}
            </h1>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            <Chip
              label="People"
              value={`${
                data?.people.filter(
                  (p) => p.name.trim() && p.protocol && p.schedule
                ).length ?? 0
              } / 3`}
              accent="moss"
            />
            <Chip
              label="Protocols"
              value={`${data?.people.filter((p) => p.protocol).length ?? 0} / 3`}
              accent="ocean"
            />
            {data?.submittedAt && (
              <Chip
                label="Submitted"
                value={new Date(data.submittedAt).toLocaleString()}
                accent="sand"
              />
            )}
          </div>
        </div>
      </section>

      {/* Tabs */}
      <nav className="sticky top-[69px] z-20 border-b border-forest-700/10 bg-sand-50/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl gap-1 px-4 md:gap-2 md:px-6">
          {TABS.map((t, i) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative flex-1 border-b-2 px-3 py-4 text-left transition md:flex-none md:min-w-[180px] ${
                  active
                    ? "border-forest-700 text-forest-800"
                    : "border-transparent text-forest-800/55 hover:text-forest-800"
                }`}
              >
                <span className="flex items-center gap-2 font-display text-base font-semibold">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                      active
                        ? "bg-forest-700 text-sand-50"
                        : "bg-forest-700/10 text-forest-800/70"
                    }`}
                  >
                    {i + 1}
                  </span>
                  {t.label}
                </span>
                <span className="mt-1 block text-[11px] text-forest-800/50">
                  {t.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Tab panels */}
      <main className="mx-auto max-w-6xl px-6 py-10">
        {tab === "plan" && <PlanTab data={data} />}
        {tab === "coordinate" && <CoordinateTab data={data} />}
        {tab === "export" && <ExportTab data={data} />}
      </main>

      <footer className="border-t border-forest-700/10 bg-white/50 py-8">
        <div className="mx-auto max-w-6xl px-6 text-center text-xs text-forest-800/55">
          Green Bench · Hazard data grounded in EPA TRI, CompTox
          &amp; RCRA classifications.
        </div>
      </footer>
    </div>
  );
}

function Chip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "moss" | "ocean" | "sand";
}) {
  const cls =
    accent === "moss"
      ? "bg-moss-100 text-moss-700"
      : accent === "ocean"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-100 text-clay-600";
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${cls}`}
    >
      <span className="text-[10px] uppercase tracking-[0.18em] opacity-70">
        {label}
      </span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

function LeafIcon() {
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
      <path d="M11 20A7 7 0 0 1 4 13c0-4 3-7 7-7h8v8a7 7 0 0 1-7 6z" />
      <path d="M4 20l8-8" />
    </svg>
  );
}
