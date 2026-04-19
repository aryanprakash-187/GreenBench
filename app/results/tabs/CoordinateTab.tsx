"use client";

import { useState } from "react";
import type { Submission } from "@/components/ResultsView";
import { SectionCard } from "@/app/results/tabs/PlanTab";

export default function CoordinateTab({ data }: { data: Submission | null }) {
  const [annualized, setAnnualized] = useState(false);
  const names =
    data?.people
      ?.map((p) => p.name)
      .filter((n) => n && n.trim().length > 0) ?? [];
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
  const volume = (weekly.volume * factor).toLocaleString();
  const plastic = weekly.plastic * factor;
  const hazardEvents = weekly.hazardEvents * factor;
  const co2eLow = (weekly.co2eLow * factor).toFixed(1);
  const co2eHigh = (weekly.co2eHigh * factor).toFixed(1);

  return (
    <div className="space-y-8">
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
            <h3 className="mt-1 font-display text-3xl font-semibold md:text-4xl">
              Coordinating {labelName} lab saves real waste.
            </h3>
          </div>
          <button
            onClick={() => setAnnualized((v) => !v)}
            className="shrink-0 rounded-full border border-sand-100/30 bg-white/5 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.2em] text-sand-100 transition hover:bg-white/15"
          >
            {annualized ? "Weekly" : "Annualized"}
          </button>
        </div>
        <div className="relative mt-8 grid gap-6 md:grid-cols-4">
          <Metric big={`${volume} mL`} label="Reagent volume saved" />
          <Metric big={`${plastic}`} label="Plastic consumables saved" />
          <Metric big={`${hazardEvents}`} label="Hazardous disposal events avoided" />
          <Metric
            big={`${co2eLow}–${co2eHigh} kg`}
            label="CO₂e range"
          />
        </div>
      </section>

      {/* Coordination recommendations */}
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
            body="Both protocols use the same annealing temperature (60 °C), extension time (30 s), and cycle count (30). Combined sample count (20) fits in one run."
            vendorTerms={[
              { raw: "Q5 Hot Start Master Mix", norm: "hot_start_endpoint_PCR" },
              { raw: "Phusion Flash 2× Mix", norm: "hot_start_endpoint_PCR" },
            ]}
            citation="Engine: thermal_profile equality check"
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
    </div>
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
  citation: string;
  savings: string;
}) {
  const [showTerms, setShowTerms] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const stripe =
    accent === "moss" ? "bg-moss-500" : "bg-ocean-400";
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
      <p className="mt-2 text-sm leading-relaxed text-forest-800/75">{body}</p>
      <p className="mt-3 text-xs font-medium text-moss-700">{savings}</p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <button
          onClick={() => setShowTerms((v) => !v)}
          className="rounded-full border border-forest-700/15 bg-white px-3 py-1 font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
        >
          {showTerms ? "Hide vendor terms" : "Show vendor terms"}
        </button>
        <button
          onClick={() => setShowWhy((v) => !v)}
          className="rounded-full border border-forest-700/15 bg-white px-3 py-1 font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
        >
          {showWhy ? "Hide why" : "Why this works"}
        </button>
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
      {showWhy && (
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
