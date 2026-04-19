"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  loadSubmission,
  namesList,
  hasPlan,
  type Submission,
} from "@/lib/submission";
import type {
  NarratedCoordination,
  NarratedSeparation,
  NarratedWeekPlanResult,
  ScheduledTask,
} from "@/lib/engine/types";

type OverviewPageProps = {
  onBack?: () => void;
  onNext?: () => void;
  onReset?: () => void;
};

export default function OverviewPage({ onBack, onNext, onReset }: OverviewPageProps = {}) {
  const router = useRouter();
  const [data, setData] = useState<Submission | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "missing">(
    "loading",
  );

  const handleNext = onNext ?? (() => router.push("/schedules"));

  useEffect(() => {
    const sub = loadSubmission();
    if (sub && hasPlan(sub)) {
      setData(sub);
      setLoadState("ok");
    } else if (sub) {
      // Old payload with no plan (e.g. from a previous build). Show missing.
      setData(sub);
      setLoadState("missing");
    } else {
      setLoadState("missing");
    }
  }, []);

  // Direct visit / refresh-after-clear should not leave the user on a dead
  // end. Briefly show the MissingState so the message is visible, then push
  // them back to step 1.
  useEffect(() => {
    if (loadState !== "missing") return;
    const t = window.setTimeout(() => router.replace("/"), 1500);
    return () => window.clearTimeout(t);
  }, [loadState, router]);

  const names = namesList(data);
  const labelName =
    names.length === 0
      ? "your"
      : names.length === 1
      ? `${names[0]}'s`
      : names.length === 2
      ? `${names[0]} & ${names[1]}'s`
      : `${names[0]}, ${names[1]} & ${names[2]}'s`;

  const plan = data?.plan;

  return (
    <div className="min-h-screen bg-sand-50 text-forest-900">
      <TopBar onBack={onBack} onReset={onReset} />

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
            {plan?.headline_tagline ??
              "The payoff. Impact summary at the top, then coordination recommendations ranked by hazard-weighted impact, separation warnings, and a visual week grid."}
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-5xl space-y-10 px-6 py-12">
        {loadState === "loading" && <LoadingState />}
        {loadState === "missing" && <MissingState />}

        {plan && loadState === "ok" && (
          <>
            <ImpactSummarySection plan={plan} labelName={labelName} />

            <SectionCard
              eyebrow="Coordination recommendations"
              title="Ranked by hazard-weighted impact"
              lede="Each card combines tasks that share a reagent or equipment run within its stability window. Expand to see vendor terms collapse to their normalized group, or the EPA citation behind every hazard call."
            >
              {plan.coordinations.length === 0 ? (
                <EmptyCard
                  title="No overlap opportunities this week."
                  body="Your protocols don't share reagents or equipment in compatible windows — nothing to consolidate."
                />
              ) : (
                <div className="space-y-4">
                  {plan.coordinations.map((c) => (
                    <RecommendationCard key={c.id} coord={c} />
                  ))}
                </div>
              )}
            </SectionCard>

            <SeparationsSection separations={plan.separations} />

            <SectionCard
              eyebrow="Week outline"
              title="Stage block view"
              lede="Each person&rsquo;s row across the week. Protocol blocks are placed only in slots free on both their uploaded busy calendar and operator availability. Shared coordination events span multiple rows."
            >
              <StageBlocks plan={plan} data={data} />
            </SectionCard>

            {plan.diagnostics?.warnings?.length ?
              <DiagnosticsCallout
                warnings={plan.diagnostics.warnings}
                unscheduled={plan.diagnostics.unscheduled ?? []}
              /> : null}

            {/* Next — advance to Finalized Schedules (Step 3) */}
            <div className="flex flex-col items-center gap-3 pt-4">
              <p className="text-[10px] uppercase tracking-[0.3em] text-forest-800/55">
                Step 3 · Export
              </p>
              <button
                type="button"
                onClick={handleNext}
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
                Continue to Finalized Schedules.
              </p>
            </div>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}

/* ---------- Loading / missing ---------- */

function LoadingState() {
  return (
    <div className="rounded-3xl border border-forest-700/10 bg-white/70 p-12 text-center text-sm text-forest-800/60 shadow-soft">
      Loading your plan…
    </div>
  );
}

function MissingState() {
  return (
    <div className="rounded-3xl border border-clay-400/30 bg-clay-400/10 p-10 text-center shadow-soft">
      <p className="text-[10px] uppercase tracking-[0.25em] text-clay-700">
        No plan in this browser
      </p>
      <h3 className="mt-2 font-display text-2xl font-semibold text-clay-700">
        We couldn&rsquo;t find a saved submission.
      </h3>
      <p className="mx-auto mt-3 max-w-md text-sm text-clay-700/85">
        Head back to step 1, fill in the form for all your labmates, and
        submit. We keep everything in your browser, so an incognito tab or a
        cleared cache will look like this.
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

function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-forest-700/10 bg-white/70 px-5 py-6 text-center text-sm text-forest-800/65">
      <p className="font-display text-lg font-semibold text-forest-800">
        {title}
      </p>
      <p className="mx-auto mt-2 max-w-md text-forest-800/65">{body}</p>
    </div>
  );
}

/* ---------- Impact summary ---------- */

function ImpactSummarySection({
  plan,
  labelName,
}: {
  plan: NarratedWeekPlanResult;
  labelName: string;
}) {
  const wk = plan.impact.weekly;
  const yr = plan.impact.annualized_if_repeated;

  const rows: {
    label: string;
    weekly: string;
    annual: string;
  }[] = [
    {
      label: "Reagent volume saved",
      weekly: `${formatNumber(wk.reagent_volume_saved_ml)} mL`,
      annual: `${formatNumber(yr.reagent_volume_saved_ml)} mL`,
    },
    {
      label: "Prep events consolidated",
      weekly: `${formatNumber(wk.prep_events_saved)}`,
      annual: `${formatNumber(yr.prep_events_saved)}`,
    },
    {
      label: "Equipment runs saved",
      weekly: `${formatNumber(wk.equipment_runs_saved)}`,
      annual: `${formatNumber(yr.equipment_runs_saved)}`,
    },
    {
      label: "CO₂e range",
      weekly: `${wk.estimated_co2e_kg_range[0].toFixed(1)}–${wk.estimated_co2e_kg_range[1].toFixed(1)} kg`,
      annual: `${yr.estimated_co2e_kg_range[0].toFixed(1)}–${yr.estimated_co2e_kg_range[1].toFixed(1)} kg`,
    },
    {
      label: "Hazardous disposal events avoided",
      weekly: `${formatNumber(wk.hazardous_disposal_events_avoided)}`,
      annual: `${formatNumber(yr.hazardous_disposal_events_avoided)}`,
    },
  ];

  return (
    <section className="relative overflow-hidden rounded-3xl border border-forest-700/10 bg-gradient-to-br from-forest-700 via-forest-600 to-ocean-700 p-8 text-sand-50 shadow-soft md:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-moss-300/20 blur-3xl"
      />
      <div className="relative">
        <p className="text-[10px] uppercase tracking-[0.25em] text-sand-100/70">
          Impact summary
        </p>
        <h2 className="mt-1 font-display text-3xl font-semibold md:text-4xl">
          Coordinating {labelName} lab saves real waste.
        </h2>
      </div>

      <div className="relative mt-8 overflow-hidden rounded-2xl border border-sand-100/15 bg-forest-900/20 backdrop-blur-sm">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 gap-y-3 px-5 py-4 text-[10px] font-semibold uppercase tracking-[0.22em] text-sand-100/70 md:px-6">
          <span>Metric</span>
          <span className="text-right">This week</span>
          <span className="text-right">Annualized (×52)</span>
        </div>
        <div className="divide-y divide-sand-100/10">
          {rows.map((r) => (
            <div
              key={r.label}
              className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6 px-5 py-3 md:px-6"
            >
              <span className="text-sm text-sand-50/90">{r.label}</span>
              <span className="text-right font-display text-xl font-semibold tabular-nums leading-none md:text-2xl">
                {r.weekly}
              </span>
              <span className="text-right font-display text-xl font-semibold tabular-nums leading-none text-moss-200 md:text-2xl">
                {r.annual}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="relative mt-4 text-[11px] text-sand-100/55">
        Annualized column assumes this same week repeats 52×. Weekly is what your lab actually saves Mon–Fri.
      </p>

      {!plan.narration.generated && plan.narration.fallback_reason && (
        <p className="relative mt-3 text-[11px] uppercase tracking-[0.16em] text-sand-100/55">
          Narration fallback: {plan.narration.fallback_reason}
        </p>
      )}
    </section>
  );
}

/* ---------- Recommendations ---------- */

function RecommendationCard({ coord }: { coord: NarratedCoordination }) {
  const [showRationale, setShowRationale] = useState(false);
  const [showCitations, setShowCitations] = useState(false);

  const accent: "moss" | "ocean" =
    coord.type === "shared_reagent_prep" ? "moss" : "ocean";
  const stripe = accent === "moss" ? "bg-moss-500" : "bg-ocean-400";

  const impact = bucketImpact(coord);
  const impactCls =
    impact === "High"
      ? "bg-moss-100 text-moss-700"
      : impact === "Medium"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-200 text-clay-600";

  const people = Array.from(new Set(coord.participants.map((p) => p.person)));
  const savingsChips = buildSavingsChips(coord);

  return (
    <article className="relative overflow-hidden rounded-2xl border border-forest-700/10 bg-white/85 p-5 md:p-6">
      <div className={`absolute left-0 top-0 h-full w-1.5 ${stripe}`} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h4 className="min-w-0 flex-1 break-words font-display text-base font-semibold leading-snug text-forest-800 [overflow-wrap:anywhere] md:text-lg">
          {coord.prose.headline || coord.recommendation}
        </h4>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${impactCls}`}
          >
            {impact} impact
          </span>
          {!coord.aligned && (
            <span className="rounded-full bg-clay-400/20 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-clay-700">
              Advisory
            </span>
          )}
        </div>
      </div>

      {coord.prose.body && (
        <p className="mt-2 text-sm leading-relaxed text-forest-800/80">
          {coord.prose.body}
        </p>
      )}

      {savingsChips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {savingsChips.map((chip, i) => (
            <span
              key={i}
              className="rounded-full bg-moss-100 px-2.5 py-1 text-[11px] font-medium text-moss-700"
            >
              {chip}
            </span>
          ))}
        </div>
      )}

      {people.length > 0 && (
        <p className="mt-3 text-xs text-forest-800/60">
          <span className="font-semibold text-forest-800/75">Covers:</span>{" "}
          {people.join(" · ")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
        <button
          onClick={() => setShowRationale((v) => !v)}
          aria-expanded={showRationale}
          className="text-xs font-medium text-forest-800/70 underline decoration-forest-800/25 underline-offset-4 transition hover:text-forest-800 hover:decoration-forest-800"
        >
          {showRationale ? "Hide engine rationale" : "Show engine rationale"}
        </button>
        {coord.citations.length > 0 && (
          <button
            onClick={() => setShowCitations((v) => !v)}
            aria-expanded={showCitations}
            className="text-xs font-medium text-forest-800/70 underline decoration-forest-800/25 underline-offset-4 transition hover:text-forest-800 hover:decoration-forest-800"
          >
            {showCitations
              ? "Hide EPA citations"
              : `Show EPA citations (${coord.citations.length})`}
          </button>
        )}
      </div>

      {showRationale && (
        <div className="mt-3 space-y-4 rounded-xl bg-forest-700/5 p-4 text-xs text-forest-800/80">
          {coord.rationale.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-forest-800/55">
                Engine rationale
              </p>
              <ul className="list-disc space-y-1 pl-4 leading-relaxed">
                {coord.rationale.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {coord.participants.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-forest-800/55">
                Participants
              </p>
              <ul className="space-y-1">
                {coord.participants.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{p.person}</span>
                    <span className="font-mono text-[11px] text-forest-800/55">
                      {shortTaskId(p.task_id)}
                    </span>
                    {typeof p.volume_ul === "number" && (
                      <span className="text-forest-800/55">
                        · {(p.volume_ul / 1000).toFixed(1)} mL
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {showCitations && coord.citations.length > 0 && (
        <div className="mt-3 rounded-xl bg-ocean-100/40 p-4 text-xs text-forest-800/80">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-forest-800/55">
            EPA citations
          </p>
          <ul className="space-y-3">
            {coord.citations.map((cite, i) => (
              <CitationItem key={i} cite={cite} />
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function CitationItem({
  cite,
}: {
  cite: NarratedCoordination["citations"][number];
}) {
  return (
    <li className="rounded-lg border border-ocean-400/20 bg-white/70 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="break-words font-medium text-forest-800 [overflow-wrap:anywhere]">
          {cite.reagent}
        </span>
        {cite.is_tri_listed && (
          <span
            className="rounded bg-clay-400/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-clay-700"
            title="EPA TRI-listed chemical (cross-verify via the TRI link in the page footer)"
          >
            TRI listed
          </span>
        )}
        {cite.rcra_code && (
          <span className="rounded bg-clay-400/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-clay-700">
            RCRA {cite.rcra_code}
          </span>
        )}
      </div>
      {cite.cas_entries.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {cite.cas_entries.map((cas, j) => (
            <li key={j} className="break-words text-[11px] leading-snug [overflow-wrap:anywhere]">
              <span className="font-mono font-semibold text-forest-800">
                CAS {cas.cas}
              </span>
              {cas.dtxsid && (
                <span className="ml-1.5 font-mono text-[10px] text-forest-800/65">
                  · DTXSID {cas.dtxsid}
                </span>
              )}
              {cas.name && (
                <span className="text-forest-800/75"> · {cas.name}</span>
              )}
              {cas.role && (
                <span className="text-forest-800/55"> ({cas.role})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function shortTaskId(taskId: string): string {
  const parts = taskId.split("__");
  return parts.length >= 2 ? parts[1] : taskId;
}

function buildSavingsChips(coord: NarratedCoordination): string[] {
  const out: string[] = [];
  const s = coord.savings;
  if (typeof s.volume_ml === "number" && s.volume_ml > 0) {
    out.push(`−${formatNumber(s.volume_ml)} mL reagent`);
  }
  if (typeof s.prep_events_saved === "number" && s.prep_events_saved > 0) {
    out.push(
      `${s.prep_events_saved} prep event${s.prep_events_saved === 1 ? "" : "s"} avoided`,
    );
  }
  if (typeof s.runs_saved === "number" && s.runs_saved > 0) {
    out.push(
      `${s.runs_saved} equipment run${s.runs_saved === 1 ? "" : "s"} saved`,
    );
  }
  if (
    typeof s.hazardous_disposal_events_avoided === "number" &&
    s.hazardous_disposal_events_avoided > 0
  ) {
    out.push(
      `${s.hazardous_disposal_events_avoided} haz-waste event${
        s.hazardous_disposal_events_avoided === 1 ? "" : "s"
      } avoided`,
    );
  }
  if (s.co2e_kg_range && (s.co2e_kg_range[0] > 0 || s.co2e_kg_range[1] > 0)) {
    out.push(
      `~${s.co2e_kg_range[0].toFixed(1)}–${s.co2e_kg_range[1].toFixed(1)} kg CO₂e`,
    );
  }
  return out;
}

function bucketImpact(c: NarratedCoordination): "High" | "Medium" | "Low" {
  const vol = c.savings.volume_ml ?? 0;
  const haz = c.savings.hazardous_disposal_events_avoided ?? 0;
  if (haz >= 1 || vol >= 50) return "High";
  if (vol >= 10 || (c.savings.prep_events_saved ?? 0) >= 1) return "Medium";
  return "Low";
}

/* ---------- Separations ---------- */

function SeparationsSection({
  separations,
}: {
  separations: NarratedSeparation[];
}) {
  return (
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
        {separations.length === 0 ? (
          <div className="rounded-2xl border border-clay-400/20 bg-white/80 px-5 py-6 text-center text-sm text-clay-700/85">
            <p className="font-display text-lg font-semibold text-clay-700">
              No incompatibility flags this week.
            </p>
            <p className="mt-2">
              The RCRA compatibility matrix didn&rsquo;t surface any conflicts
              between the protocols you uploaded.
            </p>
          </div>
        ) : (
          separations.map((s) => <WarningCard key={s.id} sep={s} />)
        )}
      </div>
    </section>
  );
}

function WarningCard({ sep }: { sep: NarratedSeparation }) {
  const sevCls =
    sep.severity === "critical"
      ? "bg-clay-500"
      : sep.severity === "warning"
      ? "bg-clay-400"
      : "bg-sand-300";
  return (
    <article className="relative overflow-hidden rounded-2xl border border-clay-400/30 bg-white/85 p-5 md:p-6">
      <div className={`absolute left-0 top-0 h-full w-1.5 ${sevCls}`} />
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h4 className="font-display text-lg font-semibold text-clay-700">
              {sep.prose.headline || sep.reason}
            </h4>
            <span className="rounded-full bg-clay-400/15 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-clay-700">
              {sep.severity}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-clay-700/85">
            {sep.prose.body}
          </p>
          {sep.citations.length > 0 && (
            <div className="mt-3 space-y-2">
              {sep.citations.map((c, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-clay-400/20 bg-white/70 p-2.5 text-[11px] text-clay-700/85"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono font-medium">
                      {c.waste_group}
                    </span>
                    {c.is_tri_listed && (
                      <span
                        className="rounded bg-clay-400/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                        title="EPA TRI-listed chemical (cross-verify via the TRI link in the page footer)"
                      >
                        TRI listed
                      </span>
                    )}
                    {c.rcra_code && (
                      <span className="rounded bg-clay-400/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold">
                        RCRA {c.rcra_code}
                      </span>
                    )}
                  </div>
                  {c.cas_entries.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {c.cas_entries.map((cas, j) => (
                        <li
                          key={j}
                          className="break-words [overflow-wrap:anywhere]"
                        >
                          <span className="font-mono font-semibold text-clay-700">
                            CAS {cas.cas}
                          </span>
                          {cas.dtxsid && (
                            <span className="ml-1.5 font-mono text-[10px] text-clay-700/65">
                              · DTXSID {cas.dtxsid}
                            </span>
                          )}
                          {cas.name && (
                            <span className="text-clay-700/75"> · {cas.name}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/* ---------- Stage block grid ---------- */

const FAMILY_TONES: Record<string, "moss" | "ocean" | "sand"> = {
  DNA_extraction: "moss",
  PCR: "ocean",
  Bead_cleanup: "sand",
};

function StageBlocks({
  plan,
  data,
}: {
  plan: NarratedWeekPlanResult;
  data: Submission | null;
}) {
  // `plan.week_start_iso` is Monday 00:00 UTC. Parsing it with `new Date(...)`
  // converts to local time, which for any timezone west of UTC (Americas)
  // lands on SUNDAY evening local — that's exactly what caused the column
  // header row to read "SUN MON TUE WED THU" instead of Mon–Fri. Anchor the
  // grid at LOCAL midnight of the Monday calendar date so the first column
  // is always Monday regardless of timezone.
  const weekStart = useMemo(
    () => parseIsoDateAsLocalMidnight(plan.week_start_iso),
    [plan.week_start_iso],
  );

  // Always show the five weekdays Mon–Fri, then append any extra days the
  // schedule actually uses (Sat/Sun overflow in far-east timezones).
  const dayKeys = useMemo(() => {
    const used = new Set<number>();
    for (let i = 0; i < 5; i++) used.add(i);
    for (const s of plan.schedule) {
      const d = dayIndex(s.start_iso, weekStart);
      if (d >= 0 && d <= 6) used.add(d);
    }
    return Array.from(used).sort((a, b) => a - b);
  }, [plan.schedule, weekStart]);

  const peopleNames =
    data?.inputs?.map((p) => p.name) ??
    Array.from(new Set(plan.schedule.map((s) => s.person)));
  const cleanedNames = peopleNames
    .map((n) => n?.trim() || "")
    .filter((n, i, arr) => n.length > 0 && arr.indexOf(n) === i);

  const weekStartLabel = weekStart.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <>
      <div className="overflow-x-auto">
        <div
          className="min-w-[640px] overflow-hidden rounded-xl border border-forest-700/10"
          style={{
            display: "grid",
            gridTemplateColumns: `140px repeat(${dayKeys.length}, minmax(110px, 1fr))`,
          }}
        >
          <div className="bg-forest-700/5 px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-forest-800/60">
            Operator
          </div>
          {dayKeys.map((d) => (
            <div
              key={d}
              className="bg-forest-700/5 px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-forest-800/60"
            >
              {dayLabel(weekStart, d)}
            </div>
          ))}
          {cleanedNames.length === 0 ? (
            <div
              className="border-t border-forest-700/10 px-4 py-6 text-sm text-forest-800/55"
              style={{ gridColumn: `1 / span ${dayKeys.length + 1}` }}
            >
              No people in this submission.
            </div>
          ) : (
            cleanedNames.map((name) => (
              <PersonRow
                key={name}
                name={name}
                dayKeys={dayKeys}
                weekStart={weekStart}
                tasks={plan.schedule.filter((s) => s.person === name)}
              />
            ))
          )}
        </div>
      </div>
      <p className="mt-4 text-xs text-forest-800/55">
        Week starts {weekStartLabel}. Tones reflect protocol family — moss =
        extraction, ocean = PCR, sand = cleanup. Tasks marked &ldquo;shared&rdquo;
        are batched with at least one other person under a coordination above.
      </p>
    </>
  );
}

function PersonRow({
  name,
  dayKeys,
  weekStart,
  tasks,
}: {
  name: string;
  dayKeys: number[];
  weekStart: Date;
  tasks: ScheduledTask[];
}) {
  const grouped: Record<number, ScheduledTask[]> = {};
  for (const t of tasks) {
    const d = dayIndex(t.start_iso, weekStart);
    if (d < 0 || d > 6) continue;
    (grouped[d] ??= []).push(t);
  }

  return (
    <>
      <div className="border-t border-forest-700/10 bg-white/60 px-4 py-5 font-display font-semibold text-forest-800">
        {name}
      </div>
      {dayKeys.map((day) => (
        <div
          key={day}
          className="space-y-1.5 border-l border-forest-700/5 border-t border-forest-700/10 bg-white/60 px-2 py-3"
        >
          {(grouped[day] ?? []).map((t) => (
            <Block key={t.task_id} task={t} />
          ))}
        </div>
      ))}
    </>
  );
}

function Block({ task }: { task: ScheduledTask }) {
  const tone = FAMILY_TONES[task.family] ?? "sand";
  const cls =
    tone === "moss"
      ? "bg-moss-200/70 text-moss-700 border-moss-500/40"
      : tone === "ocean"
      ? "bg-ocean-100/80 text-ocean-700 border-ocean-400/40"
      : "bg-sand-200 text-clay-600 border-clay-400/40";
  const startTime = formatLocalHm(task.start_iso);
  return (
    <div
      className={`rounded-lg border px-2 py-2 text-[11px] font-semibold ${cls}`}
      title={`${task.protocol_name} · ${startTime}`}
    >
      <p className="truncate">{task.protocol_name}</p>
      <p className="mt-0.5 text-[10px] font-normal opacity-80">
        {startTime}
        {task.shared_with.length > 0 && " · shared"}
      </p>
    </div>
  );
}

/** Parse the date portion (YYYY-MM-DD) of an ISO 8601 timestamp and return a
 *  Date at LOCAL midnight on that calendar date. The engine anchors weeks at
 *  Monday 00:00 UTC; naively parsing that with `new Date(iso)` would yield
 *  Sunday evening in the Americas and shift every day column by one. Reading
 *  the Y-M-D out verbatim keeps "Monday" literally Monday in the UI. */
function parseIsoDateAsLocalMidnight(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(iso);
}

/** Place each task in the column of its **local** weekday relative to the
 *  local-day of weekStart. The engine plans in UTC, but the lab cares about
 *  what local day they're physically running PCR — these can diverge for
 *  users far enough east/west of UTC. */
function dayIndex(iso: string, weekStart: Date): number {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime()) || Number.isNaN(weekStart.getTime())) return -1;
  const wsMidnight = new Date(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate()
  ).getTime();
  const tMidnight = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const ms = tMidnight - wsMidnight;
  if (ms < 0) return -1;
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/** Short weekday label for the column at `offset` days after the local-day
 *  of weekStart. Computed dynamically so a UTC-anchored weekStart that
 *  falls on a Sunday locally still labels its columns correctly. */
function dayLabel(weekStart: Date, offset: number): string {
  const ws = new Date(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate()
  );
  ws.setDate(ws.getDate() + offset);
  return ws.toLocaleDateString(undefined, { weekday: "short" });
}

function formatLocalHm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/* ---------- Diagnostics callout ---------- */

function DiagnosticsCallout({
  warnings,
  unscheduled,
}: {
  warnings: string[];
  unscheduled: { task_id: string; reason: string }[];
}) {
  if (warnings.length === 0 && unscheduled.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {unscheduled.length > 0 && (
        <div className="rounded-2xl border border-clay-400/30 bg-clay-400/10 px-4 py-3 text-xs text-clay-700">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em]">
            Unscheduled tasks ({unscheduled.length})
          </p>
          <ul className="space-y-1">
            {unscheduled.map((u) => (
              <li key={u.task_id}>
                <span className="font-mono">{u.task_id}</span> — {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-2xl border border-sand-200 bg-sand-100 px-4 py-3 text-xs text-clay-600">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em]">
            Engine warnings ({warnings.length})
          </p>
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---------- Shared cards ---------- */

export function SectionCard({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  // We render the title as a React node (not via dangerouslySetInnerHTML) so
  // a future LLM- or user-derived title can never become an XSS sink. Callers
  // that need light emphasis can pass JSX (e.g. <em>) directly.
  return (
    <section className="rounded-3xl border border-forest-700/10 bg-white/70 p-6 shadow-soft backdrop-blur md:p-8">
      <p className="text-[10px] uppercase tracking-[0.25em] text-forest-800/55">
        {eyebrow}
      </p>
      <h3 className="mt-1 font-display text-2xl font-semibold text-forest-800 md:text-3xl">
        {title}
      </h3>
      {lede && (
        <p className="mt-2 max-w-2xl text-sm text-forest-800/70">{lede}</p>
      )}
      <div className="mt-6">{children}</div>
    </section>
  );
}

/* ---------- Top bar + footer ---------- */

export function TopBar({
  onBack,
  onReset,
}: { onBack?: () => void; onReset?: () => void } = {}) {
  const newPlanClassName =
    "rounded-full border border-forest-700/20 px-4 py-1.5 text-xs font-medium uppercase tracking-[0.2em] text-forest-800 transition hover:bg-forest-700 hover:text-sand-50";
  return (
    <header className="border-b border-forest-700/10 bg-sand-50/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-forest-700/20 text-forest-800 transition hover:bg-forest-700 hover:text-sand-50"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 12H5" />
                <path d="M12 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          {onReset ? (
            <button
              type="button"
              onClick={onReset}
              className="group flex items-center gap-3"
              aria-label="Green Bench home"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-forest-700 text-sand-50">
                <LeafIcon />
              </span>
              <div className="leading-tight text-left">
                <p className="font-brand text-xl font-semibold tracking-tight text-forest-800">
                  Green Bench
                </p>
                <p className="text-[10px] uppercase tracking-[0.2em] text-forest-800/55">
                  schedule for sustainability
                </p>
              </div>
            </button>
          ) : (
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
          )}
        </div>
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            className={newPlanClassName}
          >
            ← New plan
          </button>
        ) : (
          <Link href="/" className={newPlanClassName}>
            ← New plan
          </Link>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-forest-700/10 bg-white/50 py-10">
      <div className="mx-auto max-w-5xl space-y-6 px-6">
        <section>
          <p className="text-center text-xl font-semibold uppercase tracking-[0.2em] text-forest-700">
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

/* ---------- helpers ---------- */

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}
