"use client";

import { useState } from "react";

import type { Submission } from "@/components/ResultsView";
import { SectionCard } from "@/app/results/tabs/PlanTab";
import type {
  NarratedCoordination,
  NarratedSeparation,
} from "@/lib/engine/types";

export default function CoordinateTab({ data }: { data: Submission }) {
  const [annualized, setAnnualized] = useState(false);
  const plan = data.plan;
  const view = annualized ? plan.impact.annualized_if_repeated : plan.impact.weekly;

  const names = data.people
    .map((p) => p.name)
    .filter((n) => n && n.trim().length > 0);
  const labelName =
    names.length === 0
      ? "your"
      : names.length === 1
      ? `${names[0]}'s`
      : names.length === 2
      ? `${names[0]} & ${names[1]}'s`
      : `${names[0]}, ${names[1]} & ${names[2]}'s`;

  return (
    <div className="space-y-8">
      {/* Impact summary (real numbers from engine, with Weekly/Annual toggle) */}
      <section className="relative overflow-hidden rounded-3xl border border-forest-700/10 bg-gradient-to-br from-forest-700 via-forest-600 to-ocean-700 p-8 text-sand-50 shadow-soft md:p-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-moss-300/20 blur-3xl"
        />
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-sand-100/70">
              Impact summary · {annualized ? "Annualized (×52)" : "This week"}
            </p>
            <h3 className="mt-1 font-display text-3xl font-semibold md:text-4xl">
              {plan.headline_tagline?.trim() ||
                `Coordinating ${labelName} lab saves real waste.`}
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
          <Metric
            big={formatVolume(view.reagent_volume_saved_ml)}
            label="Reagent volume saved"
          />
          <Metric
            big={`${view.prep_events_saved}`}
            label="Prep events consolidated"
          />
          <Metric
            big={`${view.equipment_runs_saved}`}
            label="Equipment runs saved"
          />
          <Metric
            big={`${view.estimated_co2e_kg_range[0].toFixed(1)}–${view.estimated_co2e_kg_range[1].toFixed(1)} kg`}
            label="CO₂e range"
          />
        </div>
        <div className="relative mt-4 text-[11px] text-sand-100/70">
          {view.hazardous_disposal_events_avoided} hazardous disposal{" "}
          {view.hazardous_disposal_events_avoided === 1 ? "event" : "events"}{" "}
          avoided ·{" "}
          {plan.narration.generated
            ? `prose by ${plan.narration.model}`
            : "deterministic prose (LLM unavailable)"}
        </div>
      </section>

      {/* Coordinations from the engine, with prose from the narrator */}
      <SectionCard
        eyebrow="Coordination recommendations"
        title="Ranked by hazard-weighted impact"
        lede="Each card combines tasks that share a reagent or equipment run within its stability window. Expand to see vendor terms collapse to their normalized group, or the EPA citation behind every hazard call."
      >
        {plan.coordinations.length === 0 ? (
          <EmptyMessage
            title="No coordination opportunities this week."
            body="Either every protocol is already fully self-contained, or the people you submitted don't have shareable reagents or batchable equipment in common."
          />
        ) : (
          <div className="space-y-4">
            {plan.coordinations.map((c) => (
              <RecommendationCard key={c.id} coord={c} />
            ))}
          </div>
        )}
      </SectionCard>

      {/* Separation warnings */}
      <section className="rounded-3xl border border-clay-400/30 bg-gradient-to-br from-clay-400/10 to-sand-100 p-6 shadow-soft md:p-8">
        <p className="text-[10px] uppercase tracking-[0.25em] text-clay-600">
          Separation warnings
        </p>
        <h3 className="mt-1 font-display text-2xl font-semibold text-clay-700 md:text-3xl">
          {plan.separations.length === 0
            ? "No incompatible waste streams detected"
            : "These waste streams must stay apart"}
        </h3>
        <p className="mt-2 max-w-2xl text-sm text-clay-700/80">
          Incompatible streams are flagged deterministically via an RCRA
          compatibility matrix. No LLM near safety-relevant decisions — the
          narrator only authors the prose around the codes.
        </p>
        {plan.separations.length === 0 ? (
          <p className="mt-6 text-sm italic text-clay-700/70">
            Your week is clean: every reagent pair across the three operators is
            compatible at the bench-disposal level.
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {plan.separations.map((s) => (
              <WarningCard key={s.id} sep={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------- Metric tile ---------- */

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

/* ---------- Recommendation card ---------- */

function RecommendationCard({ coord }: { coord: NarratedCoordination }) {
  const [showWho, setShowWho] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const accent: "moss" | "ocean" =
    coord.type === "shared_reagent_prep" ? "moss" : "ocean";

  // Impact bucket: prefer hazardous disposal avoided > runs saved > volume.
  const impact: "High" | "Medium" | "Low" = (() => {
    const s = coord.savings;
    if ((s.hazardous_disposal_events_avoided ?? 0) >= 1) return "High";
    if ((s.runs_saved ?? 0) >= 1) return "Medium";
    if ((s.volume_ml ?? 0) >= 10) return "Medium";
    return "Low";
  })();

  const stripe = accent === "moss" ? "bg-moss-500" : "bg-ocean-400";
  const impactCls =
    impact === "High"
      ? "bg-moss-100 text-moss-700"
      : impact === "Medium"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-200 text-clay-600";

  const peopleNames = uniq(coord.participants.map((p) => p.person));

  return (
    <article className="relative overflow-hidden rounded-2xl border border-forest-700/10 bg-white/80 p-5 md:p-6">
      <div className={`absolute left-0 top-0 h-full w-1.5 ${stripe}`} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h4 className="font-display text-lg font-semibold text-forest-800 md:text-xl">
          {coord.prose.headline}
        </h4>
        <div className="flex shrink-0 items-center gap-2">
          {!coord.aligned && (
            <span className="rounded-full bg-clay-400/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-clay-600">
              advisory
            </span>
          )}
          <span
            className={`rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${impactCls}`}
          >
            {impact} impact
          </span>
        </div>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-forest-800/75">
        {coord.prose.body}
      </p>
      <p className="mt-3 text-xs font-medium text-moss-700">
        {coord.prose.savings_phrase}
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <button
          onClick={() => setShowWho((v) => !v)}
          className="rounded-full border border-forest-700/15 bg-white px-3 py-1 font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
        >
          {showWho ? "Hide participants" : `Show participants (${peopleNames.length})`}
        </button>
        <button
          onClick={() => setShowWhy((v) => !v)}
          className="rounded-full border border-forest-700/15 bg-white px-3 py-1 font-medium text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
        >
          {showWhy ? "Hide why" : "Why this works"}
        </button>
      </div>

      {showWho && (
        <div className="mt-4 rounded-xl bg-forest-700/5 p-4 text-xs">
          <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-forest-800/55">
            Participants
          </p>
          <ul className="space-y-1 font-mono text-forest-800/80">
            {coord.participants.map((p) => (
              <li key={p.task_id}>
                <span className="text-clay-600">{p.person}</span>
                <span className="mx-2 text-forest-800/40">·</span>
                <span className="text-moss-700">{p.task_id}</span>
                {typeof p.volume_ul === "number" && (
                  <span className="ml-2 text-forest-800/55">
                    {(p.volume_ul / 1000).toFixed(2)} mL
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {showWhy && (
        <div className="mt-3 rounded-xl bg-ocean-100/40 p-4 text-xs text-forest-800/80">
          <p className="mb-1 text-[10px] uppercase tracking-[0.2em] text-forest-800/55">
            Engine rationale
          </p>
          {coord.rationale.length === 0 ? (
            <p className="italic text-forest-800/55">
              No rationale strings emitted by the engine for this coordination.
            </p>
          ) : (
            <ul className="space-y-1">
              {coord.rationale.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          )}
          {coord.citations.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[10px] uppercase tracking-[0.2em] text-forest-800/55">
                EPA citations
              </p>
              <ul className="space-y-1.5">
                {coord.citations.map((c, i) => (
                  <li key={i} className="flex flex-col">
                    <span className="font-mono text-[11px]">
                      {c.reagent}
                      {c.rcra_code ? (
                        <span className="ml-2 rounded bg-forest-700/10 px-1.5 py-0.5 text-[10px] text-forest-800">
                          RCRA {c.rcra_code}
                        </span>
                      ) : null}
                    </span>
                    {c.sources.map((src) => (
                      <a
                        key={src}
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-3 truncate text-[11px] text-ocean-700 hover:underline"
                      >
                        {src}
                      </a>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/* ---------- Warning card ---------- */

function WarningCard({ sep }: { sep: NarratedSeparation }) {
  const severityCls =
    sep.severity === "critical"
      ? "bg-clay-500"
      : sep.severity === "warning"
      ? "bg-clay-400"
      : sep.severity === "check"
      ? "bg-ocean-400"
      : "bg-sand-200";

  return (
    <article className="relative overflow-hidden rounded-2xl border border-clay-400/30 bg-white/85 p-5 md:p-6">
      <div className={`absolute left-0 top-0 h-full w-1.5 ${severityCls}`} />
      <div className="flex items-start gap-3">
        <span className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sand-50 ${severityCls}`}>
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-display text-lg font-semibold text-clay-700">
              {sep.prose.headline}
            </h4>
            <span className="rounded-full bg-clay-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-clay-600">
              {sep.severity}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-clay-700/85">
            {sep.prose.body}
          </p>
          {sep.citations.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-clay-600/80">
              {sep.citations.map((c, i) => (
                <li key={i}>
                  <span className="font-mono">{c.waste_group}</span>
                  {c.rcra_code && (
                    <span className="ml-2 rounded bg-clay-400/15 px-1.5 py-0.5 text-[10px]">
                      RCRA {c.rcra_code}
                    </span>
                  )}
                  {c.sources[0] && (
                    <a
                      href={c.sources[0]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-ocean-700 hover:underline"
                    >
                      source
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  );
}

/* ---------- Empty state ---------- */

function EmptyMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-forest-700/15 bg-white/40 px-5 py-8 text-center">
      <p className="font-display text-lg font-semibold text-forest-800/80">
        {title}
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm text-forest-800/55">{body}</p>
    </div>
  );
}

/* ---------- helpers ---------- */

function formatVolume(ml: number): string {
  if (ml === 0) return "0 mL";
  if (ml < 1) return `${(ml * 1000).toFixed(0)} µL`;
  if (ml < 10) return `${ml.toFixed(1)} mL`;
  if (ml >= 1000) return `${(ml / 1000).toFixed(1)} L`;
  return `${Math.round(ml)} mL`;
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
