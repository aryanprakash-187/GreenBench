"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  loadSubmission,
  namesList,
  type Submission,
  type FileStub,
} from "@/lib/submission";

export default function OverviewPage() {
  const [data, setData] = useState<Submission | null>(null);
  const [annualized, setAnnualized] = useState(false);

  useEffect(() => {
    setData(loadSubmission());
  }, []);

  const names = namesList(data);
  const labelName =
    names.length === 0
      ? "your"
      : names.length === 1
      ? `${names[0]}'s`
      : names.length === 2
      ? `${names[0]} & ${names[1]}'s`
      : `${names[0]}, ${names[1]} & ${names[2]}'s`;

  const weekly = {
    volume: 45,
    plastic: 18,
    hazardEvents: 2,
    co2eLow: 1.2,
    co2eHigh: 2.8,
  };
  const factor = annualized ? 48 : 1;

  return (
    <div className="min-h-screen bg-sand-50 text-forest-900">
      <TopBar />

      {/* Centered title hero */}
      <section className="border-b border-forest-700/10 bg-white/50">
        <div className="mx-auto max-w-5xl px-6 py-16 text-center md:py-24">
          <p className="mb-3 text-[11px] uppercase tracking-[0.3em] text-forest-800/55">
            Step 2 · Coordinate
          </p>
          <h1 className="font-brand text-[clamp(3.5rem,9vw,7rem)] font-medium leading-none tracking-[0.01em] text-forest-800">
            Overview
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-forest-800/70 md:text-base">
            The payoff. Impact summary at the top, then coordination
            recommendations ranked by hazard-weighted impact, separation
            warnings, and a visual week grid.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-5xl space-y-10 px-6 py-12">
        {/* Impact summary */}
        <section className="relative overflow-hidden rounded-3xl border border-forest-700/10 bg-gradient-to-br from-forest-700 via-forest-600 to-ocean-700 p-8 text-sand-50 shadow-soft md:p-10">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-moss-300/20 blur-3xl"
          />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.25em] text-sand-100/70">
                Impact summary · {annualized ? "Annualized" : "This week"}
              </p>
              <h2 className="mt-1 font-display text-3xl font-semibold md:text-4xl">
                Coordinating {labelName} lab saves real waste.
              </h2>
            </div>
            <button
              onClick={() => setAnnualized((v) => !v)}
              className="spin-light shrink-0 rounded-full bg-forest-800/80 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-sand-50 backdrop-blur transition hover:bg-forest-700"
            >
              {annualized ? "Weekly" : "Annualized"}
            </button>
          </div>
          <div className="relative mt-8 grid gap-6 md:grid-cols-4">
            <Metric
              big={`${(weekly.volume * factor).toLocaleString()} mL`}
              label="Reagent volume saved"
            />
            <Metric
              big={`${weekly.plastic * factor}`}
              label="Plastic consumables saved"
            />
            <Metric
              big={`${weekly.hazardEvents * factor}`}
              label="Hazardous disposal events avoided"
            />
            <Metric
              big={`${(weekly.co2eLow * factor).toFixed(1)}–${(
                weekly.co2eHigh * factor
              ).toFixed(1)} kg`}
              label="CO₂e range"
            />
          </div>
        </section>

        {/* Recommendations */}
        <SectionCard
          eyebrow="Coordination recommendations"
          title="Ranked by hazard-weighted impact"
          lede="Each card combines tasks that share a reagent or equipment run within its stability window. Expand to see vendor terms collapse to their normalized group, or the EPA citation behind every hazard call."
        >
          <div className="space-y-4">
            <RecommendationCard
              impact="High"
              accent="moss"
              title="Prep 60 mL of 70% ethanol once Monday morning"
              body="Covers the DNeasy wash (Mon), the MagJET wash (Tue), and the AMPure cleanup (Thu). You&rsquo;d have prepped three separate times; this consolidates to one."
              vendorTerms={[
                { raw: "Buffer AW2", norm: "ethanol_50_to_100" },
                { raw: "Wash Buffer 2", norm: "ethanol_50_to_100" },
                { raw: "80% EtOH wash", norm: "ethanol_50_to_100" },
              ]}
              citation="EPA CompTox · CASRN 64-17-5 · RCRA D001 (ignitable)"
              savings="Saves ~40 mL reagent · 2 prep events"
            />
            <RecommendationCard
              impact="Medium"
              accent="ocean"
              title="Batch two PCRs on a single 96-well block"
              body="Both protocols use the same annealing temperature (60 °C), extension time (30 s), and cycle count (30). Combined sample count fits in one run."
              vendorTerms={[
                {
                  raw: "Q5 Hot Start Master Mix",
                  norm: "hot_start_endpoint_PCR",
                },
                { raw: "Phusion Flash 2× Mix", norm: "hot_start_endpoint_PCR" },
              ]}
              savings="Saves 1 thermocycler run · ~0.4 kWh"
            />
            <RecommendationCard
              impact="Medium"
              accent="moss"
              title="Share Proteinase K aliquot across two extractions"
              body="Both DNA extractions call for Proteinase K within a 3-hour window. Single aliquot covers both without exceeding stability at 25 °C."
              vendorTerms={[
                { raw: "Proteinase K", norm: "proteinase_k" },
                { raw: "QIAGEN Protease", norm: "proteinase_k" },
              ]}
              citation="EPA CompTox · CASRN 39450-01-6 · reagent_stability: 4h @ 25°C"
              savings="Saves 120 µL enzyme · 1 prep event"
            />
          </div>
        </SectionCard>

        {/* Separation warnings */}
        <section className="rounded-3xl border border-clay-400/30 bg-gradient-to-br from-clay-400/10 to-sand-100 p-6 shadow-soft md:p-8">
          <p className="text-[10px] uppercase tracking-[0.25em] text-clay-600">
            Separation warnings
          </p>
          <h3 className="mt-1 font-display text-2xl font-semibold text-clay-700 md:text-3xl">
            These waste streams must stay apart
          </h3>
          <p className="mt-2 max-w-2xl text-sm text-clay-700/80">
            Incompatible streams are flagged deterministically via an RCRA
            compatibility matrix. No LLM near safety-relevant decisions.
          </p>
          <div className="mt-6 space-y-4">
            <WarningCard
              title="Buffer AL waste must not mix with gel decontamination bleach"
              reason="Chaotropic salts react with hypochlorite to release hazardous gas. Keep Buffer AL waste in a dedicated container labeled &lsquo;chaotropic, bleach-incompatible.&rsquo;"
              citation="EPA RCRA · guanidinium thiocyanate incompatibility · OSHA chemical hygiene"
            />
            <WarningCard
              title="Phenol-chloroform (halogenated organic) must not enter aqueous waste"
              reason="Halogenated organics require a separate stream per RCRA F-list classification. Label as F002/F003 halogenated waste."
              citation="EPA RCRA F-list · CompTox CASRN 108-95-2 / 67-66-3"
            />
          </div>
        </section>

        {/* Stage block view */}
        <SectionCard
          eyebrow="Week outline"
          title="Stage block view"
          lede="Each person&rsquo;s row across the week. Protocol blocks are placed only in slots free on both their uploaded busy calendar and operator availability. Shared coordination events span multiple rows."
        >
          <StageBlocks data={data} />
        </SectionCard>

        {/* Next — advance to Finalized Schedules (Step 3) */}
        <div className="flex flex-col items-center gap-3 pt-4">
          <p className="text-[10px] uppercase tracking-[0.3em] text-forest-800/55">
            Step 3 · Export
          </p>
          <button
            type="button"
            onClick={() =>
              window.open("/schedules", "_blank", "noopener,noreferrer")
            }
            className="group inline-flex items-center gap-3 rounded-full bg-forest-700 px-10 py-4 text-sm font-semibold uppercase tracking-[0.2em] text-sand-50 shadow-soft transition hover:bg-forest-800 active:translate-y-px"
          >
            <span>Next</span>
            <svg
              className="h-4 w-4 transition group-hover:translate-x-1"
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
            Opens Finalized Schedules in a new tab.
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}

/* ---------- Plan snapshot ---------- */

function PlanSnapshot({ data }: { data: Submission | null }) {
  const ACCENTS = ["moss", "ocean", "sand"] as const;
  const people = data?.people ?? [];

  return (
    <SectionCard
      eyebrow="Plan"
      title="Who&rsquo;s on the plan"
      lede="Parsed inputs from your submission. Each person&rsquo;s protocol is parsed into structured steps, reagents, and timings; their calendar is treated as a hard busy constraint."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => {
          const p = people[i];
          return (
            <PersonCard
              key={i}
              index={i}
              accent={ACCENTS[i]}
              name={p?.name || ""}
              protocol={p?.protocol ?? null}
              schedule={p?.schedule ?? null}
              sampleCount={p?.sampleCount || ""}
            />
          );
        })}
      </div>
    </SectionCard>
  );
}

function PersonCard({
  index,
  accent,
  name,
  protocol,
  schedule,
  sampleCount,
}: {
  index: number;
  accent: "moss" | "ocean" | "sand";
  name: string;
  protocol: FileStub;
  schedule: FileStub;
  sampleCount: string;
}) {
  const badge =
    accent === "moss"
      ? "bg-moss-100 text-moss-700"
      : accent === "ocean"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-200 text-clay-600";

  const empty = !name && !protocol && !schedule && !sampleCount;

  return (
    <div
      className={`rounded-2xl border border-forest-700/10 bg-white/70 p-5 ${
        empty ? "opacity-60" : ""
      }`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-xl font-display text-sm font-semibold ${badge}`}
          >
            {index + 1}
          </span>
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-forest-800/55">
              Person {index + 1}
            </p>
            <p className="font-display text-lg font-semibold text-forest-800">
              {name || (
                <span className="text-forest-800/40">— not provided</span>
              )}
            </p>
          </div>
        </div>
        {sampleCount && (
          <span className="rounded-full bg-forest-700/10 px-3 py-1 text-[11px] font-semibold text-forest-800">
            {sampleCount} {sampleCount === "1" ? "sample" : "samples"}
          </span>
        )}
      </div>
      <ul className="space-y-2 text-xs">
        <FileRow label="Lab Protocol" file={protocol} dot="bg-moss-500" />
        <FileRow label="Schedule (.ics)" file={schedule} dot="bg-ocean-400" />
      </ul>
    </div>
  );
}

function FileRow({
  label,
  file,
  dot,
}: {
  label: string;
  file: FileStub;
  dot: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-forest-700/10 bg-white/70 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-forest-800/55">
            {label}
          </p>
          <p className="truncate font-medium text-forest-800">
            {file ? (
              file.name
            ) : (
              <span className="text-forest-800/40">— not provided</span>
            )}
          </p>
        </div>
      </div>
      {file && (
        <span className="shrink-0 text-[11px] text-forest-800/50">
          {(file.size / 1024).toFixed(1)} KB
        </span>
      )}
    </li>
  );
}

/* ---------- Stage block grid ---------- */

function StageBlocks({ data }: { data: Submission | null }) {
  const rows = [0, 1, 2].map((i) => ({
    name: data?.people?.[i]?.name?.trim() || `Person ${i + 1}`,
    blocks:
      i === 0
        ? [
            { day: 0, label: "DNA extraction", tone: "moss" as const },
            { day: 2, label: "PCR setup", tone: "ocean" as const },
          ]
        : i === 1
        ? [
            { day: 1, label: "Bead cleanup", tone: "sand" as const },
            { day: 3, label: "Shared prep", tone: "moss" as const },
          ]
        : [{ day: 4, label: "PCR", tone: "ocean" as const }],
  }));

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-forest-700/10">
        <div className="grid grid-cols-[140px_repeat(5,1fr)] bg-forest-700/5 text-[11px] uppercase tracking-[0.18em] text-forest-800/60">
          <div className="px-4 py-3">Operator</div>
          {["Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => (
            <div key={d} className="px-4 py-3">
              {d}
            </div>
          ))}
        </div>
        {rows.map((row, i) => (
          <div
            key={i}
            className="grid grid-cols-[140px_repeat(5,1fr)] border-t border-forest-700/10 bg-white/60"
          >
            <div className="border-r border-forest-700/10 px-4 py-5 font-display font-semibold text-forest-800">
              {row.name}
            </div>
            {[0, 1, 2, 3, 4].map((day) => {
              const b = row.blocks.find((x) => x.day === day);
              return (
                <div
                  key={day}
                  className="border-r border-forest-700/5 px-2 py-3 last:border-r-0"
                >
                  {b ? <Block label={b.label} tone={b.tone} /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-forest-800/55">
        Mockup of the stage-block view. Once connected to the engine, block
        placement reflects parsed protocol durations, equipment availability,
        and busy ICS constraints.
      </p>
    </>
  );
}

function Block({
  label,
  tone,
}: {
  label: string;
  tone: "moss" | "ocean" | "sand";
}) {
  const cls =
    tone === "moss"
      ? "bg-moss-200/70 text-moss-700 border-moss-500/40"
      : tone === "ocean"
      ? "bg-ocean-100/80 text-ocean-700 border-ocean-400/40"
      : "bg-sand-200 text-clay-600 border-clay-400/40";
  return (
    <div
      className={`rounded-lg border px-2 py-2 text-[11px] font-semibold ${cls}`}
    >
      {label}
    </div>
  );
}

/* ---------- Shared cards ---------- */

function SectionCard({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-forest-700/10 bg-white/70 p-6 shadow-soft backdrop-blur md:p-8">
      <p className="text-[10px] uppercase tracking-[0.25em] text-forest-800/55">
        {eyebrow}
      </p>
      <h3
        className="mt-1 font-display text-2xl font-semibold text-forest-800 md:text-3xl"
        dangerouslySetInnerHTML={{ __html: title }}
      />
      {lede && (
        <p className="mt-2 max-w-2xl text-sm text-forest-800/70">{lede}</p>
      )}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Metric({ big, label }: { big: string; label: string }) {
  return (
    <div>
      <p className="font-display text-4xl font-bold leading-none md:text-5xl">
        {big}
      </p>
      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-sand-100/70">
        {label}
      </p>
    </div>
  );
}

function RecommendationCard({
  impact,
  accent,
  title,
  body,
  vendorTerms,
  citation,
  savings,
}: {
  impact: "High" | "Medium" | "Low";
  accent: "moss" | "ocean";
  title: string;
  body: string;
  vendorTerms: { raw: string; norm: string }[];
  // Optional: omit for non-chemical / process-match steps (e.g. PCR batching)
  // where no EPA/RCRA identifier applies.
  citation?: string;
  savings: string;
}) {
  const [showTerms, setShowTerms] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const stripe = accent === "moss" ? "bg-moss-500" : "bg-ocean-400";
  const impactCls =
    impact === "High"
      ? "bg-moss-100 text-moss-700"
      : impact === "Medium"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-200 text-clay-600";

  return (
    <article className="relative overflow-hidden rounded-2xl border border-forest-700/10 bg-white/80 p-5 md:p-6">
      <div className={`absolute left-0 top-0 h-full w-1.5 ${stripe}`} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h4 className="font-display text-lg font-semibold text-forest-800 md:text-xl">
          {title}
        </h4>
        <span
          className={`rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${impactCls}`}
        >
          {impact} impact
        </span>
      </div>
      <p
        className="mt-2 text-sm leading-relaxed text-forest-800/75"
        dangerouslySetInnerHTML={{ __html: body }}
      />
      <p className="mt-3 text-xs font-medium text-moss-700">{savings}</p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <button
          onClick={() => setShowTerms((v) => !v)}
          className="rounded-full border border-forest-700/15 bg-white px-3 py-1 font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
        >
          {showTerms ? "Hide vendor terms" : "Show vendor terms"}
        </button>
        {citation && (
          <button
            onClick={() => setShowWhy((v) => !v)}
            className="rounded-full border border-forest-700/15 bg-white px-3 py-1 font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
          >
            {showWhy ? "Hide EPA citation" : "EPA citation"}
          </button>
        )}
      </div>

      {showTerms && (
        <div className="mt-4 rounded-xl bg-forest-700/5 p-4 text-xs">
          <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-forest-800/55">
            Vendor term normalization
          </p>
          <ul className="space-y-1 font-mono text-forest-800/80">
            {vendorTerms.map((t) => (
              <li key={t.raw}>
                <span className="text-clay-600">{t.raw}</span>
                <span className="mx-2 text-forest-800/40">→</span>
                <span className="text-moss-700">{t.norm}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showWhy && citation && (
        <div className="mt-3 rounded-xl bg-ocean-100/40 p-4 text-xs text-forest-800/80">
          <p className="mb-1 text-[10px] uppercase tracking-[0.2em] text-forest-800/55">
            EPA citation
          </p>
          {citation}
        </div>
      )}
    </article>
  );
}

function WarningCard({
  title,
  reason,
  citation,
}: {
  title: string;
  reason: string;
  citation: string;
}) {
  return (
    <article className="relative overflow-hidden rounded-2xl border border-clay-400/30 bg-white/85 p-5 md:p-6">
      <div className="absolute left-0 top-0 h-full w-1.5 bg-clay-500" />
      <div className="flex items-start gap-3">
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-clay-500 text-sand-50">
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </span>
        <div>
          <h4
            className="font-display text-lg font-semibold text-clay-700"
            dangerouslySetInnerHTML={{ __html: title }}
          />
          <p
            className="mt-2 text-sm leading-relaxed text-clay-700/85"
            dangerouslySetInnerHTML={{ __html: reason }}
          />
          <p className="mt-3 text-xs text-clay-600/80">{citation}</p>
        </div>
      </div>
    </article>
  );
}

/* ---------- Top bar + footer ---------- */

export function TopBar() {
  return (
    <header className="border-b border-forest-700/10 bg-sand-50/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
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
  );
}

export function Footer() {
  return (
    <footer className="border-t border-forest-700/10 bg-white/50 py-10">
      <div className="mx-auto max-w-5xl space-y-6 px-6">
        <section>
          <p className="text-center text-[10px] uppercase tracking-[0.3em] text-forest-800/55">
            Verify our data
          </p>
          <p className="mx-auto mt-2 max-w-2xl text-center text-xs text-forest-800/60">
            Every DTXSID, CAS number, TRI flag, and RCRA code on this site
            links directly into these EPA databases. Cross-check any claim:
          </p>
          <ul className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <li>
              <a
                href="https://comptox.epa.gov/dashboard/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-forest-700/20 bg-white px-4 py-1.5 text-xs font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
              >
                <ExternalIcon />
                Look up a DTXSID or CAS number
              </a>
            </li>
            <li>
              <a
                href="https://www.epa.gov/toxics-release-inventory-tri-program/tri-listed-chemicals"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-forest-700/20 bg-white px-4 py-1.5 text-xs font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
              >
                <ExternalIcon />
                TRI-listed chemicals
              </a>
            </li>
            <li>
              <a
                href="https://www.epa.gov/hw/defining-hazardous-waste-listed-characteristic-and-mixed-radiological-wastes"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-forest-700/20 bg-white px-4 py-1.5 text-xs font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
              >
                <ExternalIcon />
                RCRA waste code definitions
              </a>
            </li>
          </ul>
        </section>

        <p className="border-t border-forest-700/10 pt-5 text-center text-xs text-forest-800/55">
          Green Bench · Hazard data grounded in EPA TRI, CompTox &amp; RCRA
          classifications.
        </p>
      </div>
    </footer>
  );
}

function ExternalIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 opacity-70"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3h7v7" />
      <path d="M21 3l-9 9" />
      <path d="M19 14v6a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1h6" />
    </svg>
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
