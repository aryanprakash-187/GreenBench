"use client";

// Per-reagent confirmation UI for a freshly parsed protocol PDF.
//
// The user just uploaded a PDF; /api/parse returned a `DraftProtocol`
// containing the LLM's best guess at each reagent's overlap group. This
// component renders one card per reagent, defaults the overlap-group select
// to the LLM's proposal, and lets the user accept, change, or mark as
// "new" before the draft is resolved into an EnrichedProtocol.
//
// Confirmations live in the parent's React state only (session-scoped per
// the v1 plan). HomeForm calls /api/parse first, queues each person's
// draft for review, then sends the confirmed set to /api/plan.

import { useMemo, useState } from "react";

import type {
  DraftMissingInformation,
  DraftProtocol,
  DraftReagent,
  ReagentConfirmation,
} from "@/lib/engine/types";

type Props = {
  personName: string;
  filename: string;
  sampleCount: number;
  draft: DraftProtocol;
  /** Closed vocabulary of overlap groups the user can pick from (plus the
   *  literal `"new"` token). The /api/parse response carries this. */
  allowedOverlapGroups: string[];
  /** Previously-saved confirmations for this draft, when the user is
   *  revisiting via the Back button. Seeds the row state so edits survive
   *  navigation. `null` on first visit. */
  initialConfirmations?: ReagentConfirmation[] | null;
  /** 0-based index of this protocol in the multi-PDF review wizard. */
  stepIndex?: number;
  /** Total protocols being reviewed in this session. */
  stepCount?: number;
  /** Step back to the previous protocol, carrying the current step's edits so
   *  they're preserved. Undefined on the first step. */
  onBack?: (confirmations: ReagentConfirmation[]) => void;
  onConfirm: (confirmations: ReagentConfirmation[]) => void;
  onCancel: () => void;
};

const FAMILY_LABEL: Record<string, string> = {
  DNA_extraction: "DNA extraction",
  PCR: "PCR",
  Bead_cleanup: "Bead cleanup",
  Sequencing: "Sequencing",
  Other: "Other",
};

export default function ProtocolDraftReview({
  personName,
  filename,
  sampleCount,
  draft,
  allowedOverlapGroups,
  initialConfirmations,
  stepIndex,
  stepCount,
  onBack,
  onConfirm,
  onCancel,
}: Props) {
  // One row of pending state per reagent. Keyed by raw_term (unique per
  // protocol). Seeds from previously-saved confirmations when the user is
  // navigating back to a protocol they already touched.
  const [rows, setRows] = useState<ReagentConfirmation[]>(() =>
    draft.reagents.map((r) => {
      const prior = initialConfirmations?.find(
        (c) => c.raw_term === r.raw_term,
      );
      if (prior) return prior;
      return {
        raw_term: r.raw_term,
        confirmed_overlap_group: r.proposed_overlap_group,
        volume_per_sample_ul:
          typeof r.volume_per_sample_ul === "number"
            ? r.volume_per_sample_ul
            : 0,
      };
    }),
  );

  // Partition reagents into the two review sections, preserving each
  // reagent's index in the original `rows` array (the join key for edits):
  //   - "needs your input": the PDF didn't quantify the volume, or the
  //     parser couldn't match a known overlap group ("new").
  //   - "extracted cleanly": everything else, shown for optional review.
  const { needs, clean } = useMemo(() => {
    const needsRows: { reagent: DraftReagent; idx: number }[] = [];
    const cleanRows: { reagent: DraftReagent; idx: number }[] = [];
    draft.reagents.forEach((r, idx) => {
      if (r.volume_per_sample_ul == null || r.proposed_overlap_group === "new") {
        needsRows.push({ reagent: r, idx });
      } else {
        cleanRows.push({ reagent: r, idx });
      }
    });
    return { needs: needsRows, clean: cleanRows };
  }, [draft.reagents]);

  // Parser explanations for un-quantified volumes, keyed by the reagent's
  // raw_term. The parser emits these as missing_information entries whose
  // `field` looks like `reagents[<raw_term>].volume_per_sample_ul`.
  const volumeWhyByRawTerm = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of draft.missing_information) {
      const m = item.field.match(
        /^reagents\[(.+)\]\.volume_per_sample_ul$/,
      );
      if (m) map.set(m[1], item.why);
    }
    return map;
  }, [draft.missing_information]);

  // Any remaining parser notes that aren't a per-reagent volume (CAS numbers,
  // sample defaults, thermal fields, …). Those are surfaced inline above, so
  // we only show the leftovers read-only.
  const residualMissing = useMemo(
    () =>
      draft.missing_information.filter(
        (item) =>
          !/^reagents\[(.+)\]\.volume_per_sample_ul$/.test(item.field),
      ),
    [draft.missing_information],
  );

  function missingReasonFor(reagent: DraftReagent): string | undefined {
    const reasons: string[] = [];
    if (reagent.volume_per_sample_ul == null) {
      reasons.push(
        volumeWhyByRawTerm.get(reagent.raw_term) ??
          "The document does not specify a per-sample volume. Enter one so this reagent counts toward shared-prep savings.",
      );
    }
    if (reagent.proposed_overlap_group === "new") {
      reasons.push(
        "The parser couldn't match this to a known overlap group. Pick the closest group, or keep it as a new group (no shared prep).",
      );
    }
    return reasons.length > 0 ? reasons.join(" ") : undefined;
  }

  function updateRow(rawTerm: string, patch: Partial<ReagentConfirmation>) {
    setRows((prev) =>
      prev.map((r) =>
        r.raw_term === rawTerm ? { ...r, ...patch } : r,
      ),
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(rows);
  }

  // Last step of the wizard (or a single-protocol session) → the confirm
  // button finishes and runs the plan rather than advancing.
  const isLastStep =
    typeof stepCount !== "number" ||
    typeof stepIndex !== "number" ||
    stepIndex >= stepCount - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-forest-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Review parsed protocol for ${personName}`}
    >
      <form
        onSubmit={handleSubmit}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-forest-700/10 bg-white shadow-soft"
      >
        {/* ---------- Header ---------- */}
        <header className="flex flex-col gap-2 border-b border-forest-700/10 bg-sand-50 px-6 py-5 md:px-8 md:py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="inline-block rounded-full border border-forest-700/15 bg-white/80 px-3 py-1 text-[10px] uppercase tracking-[0.25em] text-forest-700/80">
                Review parsed protocol · {personName}
              </p>
              {typeof stepCount === "number" && stepCount > 1 && (
                <span className="inline-block rounded-full border border-moss-500/30 bg-moss-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-moss-700">
                  Protocol {(stepIndex ?? 0) + 1} of {stepCount}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-forest-700/10 bg-white/70 px-3 py-1 text-xs font-medium text-forest-800/70 transition hover:border-clay-400/40 hover:bg-clay-400/10 hover:text-clay-700"
            >
              Cancel upload
            </button>
          </div>
          <h2 className="font-display text-2xl font-semibold text-forest-800 md:text-3xl">
            {draft.protocol_name}
          </h2>
          <p className="text-sm text-forest-800/65">
            Parsed from{" "}
            <code className="font-mono text-xs">{filename}</code>
            {draft.vendor ? ` · ${draft.vendor}` : ""} ·{" "}
            {FAMILY_LABEL[draft.family] ?? draft.family}
            {" · "}
            <span className="font-medium text-forest-800/90">
              {sampleCount} sample{sampleCount === 1 ? "" : "s"}
            </span>
          </p>
          <p className="text-xs leading-relaxed text-forest-800/55">
            We extracted the reagents and equipment below from your PDF.
            Please review each reagent and confirm or change the overlap
            group — this is what lets us spot shared prep across labmates.
            Highlighted rows need a closer look.
          </p>
        </header>

        {/* ---------- Body ---------- */}
        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6 md:px-8">
          {/* Section 1 — reagents that need the user's input */}
          {needs.length > 0 && (
            <section>
              <SectionTitle title="Needs your input" count={needs.length} />
              <p className="mb-3 text-xs leading-relaxed text-forest-800/55">
                The PDF didn&rsquo;t fully specify these. Each one shows what
                we couldn&rsquo;t find; add the missing volume (and confirm the
                overlap group) so it counts toward shared-prep coordination.
              </p>
              <div className="space-y-3">
                {needs.map(({ reagent, idx }) => (
                  <ReagentRow
                    key={`needs-${reagent.raw_term}__${idx}`}
                    reagent={reagent}
                    current={rows[idx]}
                    allowedOverlapGroups={allowedOverlapGroups}
                    flagged
                    missingReason={missingReasonFor(reagent)}
                    onChange={(patch) => updateRow(reagent.raw_term, patch)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Section 2 — reagents extracted cleanly, open to review */}
          {clean.length > 0 && (
            <section>
              <SectionTitle
                title="Review extracted reagents"
                count={clean.length}
              />
              <p className="mb-3 text-xs leading-relaxed text-forest-800/55">
                These came through with a volume and an overlap group. Change
                the group or volume if anything looks off — otherwise leave
                them as parsed.
              </p>
              <div className="space-y-3">
                {clean.map(({ reagent, idx }) => (
                  <ReagentRow
                    key={`clean-${reagent.raw_term}__${idx}`}
                    reagent={reagent}
                    current={rows[idx]}
                    allowedOverlapGroups={allowedOverlapGroups}
                    flagged={false}
                    onChange={(patch) => updateRow(reagent.raw_term, patch)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Equipment */}
          {draft.equipment_required.length > 0 && (
            <section>
              <SectionTitle
                title="Equipment"
                count={draft.equipment_required.length}
              />
              <ul className="flex flex-wrap gap-2">
                {draft.equipment_required.map((eq, i) => (
                  <li
                    key={`${eq.equipment_type}-${i}`}
                    className="rounded-full border border-forest-700/15 bg-sand-100 px-3 py-1.5 text-xs text-forest-800"
                  >
                    <span className="font-semibold">{eq.equipment_type}</span>
                    {eq.model_hint ? (
                      <span className="text-forest-800/65">
                        {" "}
                        · {eq.model_hint}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-forest-800/55">
                The scheduler will try to match these against the lab&rsquo;s
                instrument catalog when it plans the week.
              </p>
            </section>
          )}

          {/* Other parser notes — anything missing that isn't a per-reagent
              volume (CAS numbers, sample defaults, thermal fields). Read-only;
              the volume gaps are handled inline in "Needs your input" above. */}
          {residualMissing.length > 0 && (
            <section>
              <SectionTitle
                title="Other parser notes"
                count={residualMissing.length}
              />
              <ul className="space-y-2">
                {residualMissing.map((m, i) => (
                  <MissingRow key={`${m.field}-${i}`} item={m} />
                ))}
              </ul>
              <p className="mt-2 text-xs text-forest-800/55">
                The parser didn&rsquo;t find these in the PDF. The plan will
                still run; affected coordinations may be marked advisory.
              </p>
            </section>
          )}
        </div>

        {/* ---------- Footer ---------- */}
        <footer className="flex flex-col items-center justify-between gap-3 border-t border-forest-700/10 bg-sand-50 px-6 py-4 md:flex-row md:px-8">
          <p className="text-xs text-forest-800/60">
            {needs.length > 0
              ? `${needs.length} reagent${
                  needs.length === 1 ? "" : "s"
                } need a quick check before we plan.`
              : "Looks good. Confirm to coordinate this person's week."}
          </p>
          <div className="flex gap-2">
            {onBack && (
              <button
                type="button"
                onClick={() => onBack(rows)}
                className="rounded-full border border-forest-700/15 bg-white/80 px-5 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-forest-800/75 transition hover:border-forest-700/30 hover:bg-white"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-forest-700/15 bg-white/80 px-5 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-forest-800/75 transition hover:border-forest-700/30 hover:bg-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-full bg-forest-700 px-6 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-sand-50 shadow-soft transition hover:bg-forest-800"
            >
              {isLastStep ? "Confirm & plan" : "Confirm & continue"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

/* ---------- subcomponents ---------- */

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h3 className="font-display text-base font-semibold text-forest-800">
        {title}
      </h3>
      <span className="text-xs text-forest-800/55">({count})</span>
    </div>
  );
}

function ReagentRow({
  reagent,
  current,
  allowedOverlapGroups,
  flagged,
  missingReason,
  onChange,
}: {
  reagent: DraftReagent;
  current: ReagentConfirmation;
  allowedOverlapGroups: string[];
  flagged: boolean;
  /** Parser explanation of what's missing for this reagent, shown inline.
   *  Only set in the "Needs your input" section. */
  missingReason?: string;
  onChange: (patch: Partial<ReagentConfirmation>) => void;
}) {
  const overlapGroups = useMemo(() => {
    // Show "new" last so users have to scroll past the real options first.
    const list = allowedOverlapGroups.filter((g) => g !== "new");
    list.sort();
    list.push("new");
    return list;
  }, [allowedOverlapGroups]);

  const volume =
    Number.isFinite(current.volume_per_sample_ul)
      ? String(current.volume_per_sample_ul)
      : "";

  return (
    <div
      className={`rounded-2xl border p-4 transition ${
        flagged
          ? "border-clay-400/40 bg-clay-400/5"
          : "border-forest-700/10 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-forest-800">
            {reagent.raw_term}
          </p>
          <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-forest-800/55">
            {reagent.proposed_stage}
            {reagent.cas_number ? ` · CAS ${reagent.cas_number}` : ""}
          </p>
        </div>
        {flagged && (
          <span className="shrink-0 rounded-full bg-clay-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-clay-700">
            review
          </span>
        )}
      </div>

      {missingReason && (
        <p className="mt-2 rounded-lg border border-clay-400/25 bg-clay-400/5 px-3 py-2 text-[12px] leading-snug text-forest-800/75">
          {missingReason}
        </p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-forest-800/80">
          <span className="font-semibold uppercase tracking-[0.16em] text-forest-800/65">
            Overlap group
          </span>
          <select
            value={current.confirmed_overlap_group}
            onChange={(e) =>
              onChange({ confirmed_overlap_group: e.target.value })
            }
            className="h-10 rounded-lg border border-forest-700/15 bg-white px-3 text-sm text-forest-900 outline-none transition focus:border-moss-500 focus:ring-2 focus:ring-moss-400/30"
          >
            {overlapGroups.map((g) => (
              <option key={g} value={g}>
                {g === "new" ? "— new group (no shared prep) —" : g}
              </option>
            ))}
          </select>
          {reagent.proposed_overlap_group !== current.confirmed_overlap_group && (
            <span className="text-[11px] text-forest-800/55">
              Parser suggested{" "}
              <code className="font-mono">
                {reagent.proposed_overlap_group}
              </code>
              .
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1 text-xs text-forest-800/80">
          <span className="font-semibold uppercase tracking-[0.16em] text-forest-800/65">
            Per-sample volume{" "}
            {/* `uppercase` on the parent maps µ (U+00B5 MICRO SIGN) to Greek
                capital Mu, which renders as an indistinguishable "M" in most
                fonts — silently turning "µL" into what looks like "mL" and
                making users think they should enter milliliter-scale
                numbers. `normal-case` cancels the transform for just this
                unit so it always renders as "(µL)". */}
            <span className="normal-case">(µL)</span>
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.1"
            value={volume}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({
                volume_per_sample_ul: Number.isFinite(n) ? Math.max(0, n) : 0,
              });
            }}
            placeholder={
              reagent.volume_per_sample_ul == null
                ? "PDF didn't say — please enter"
                : "0"
            }
            className="h-10 rounded-lg border border-forest-700/15 bg-white px-3 text-sm text-forest-900 outline-none transition focus:border-moss-500 focus:ring-2 focus:ring-moss-400/30"
          />
        </label>
      </div>
    </div>
  );
}

function MissingRow({ item }: { item: DraftMissingInformation }) {
  return (
    <li className="rounded-xl border border-sand-200 bg-sand-50 px-3 py-2 text-xs text-forest-800/80">
      <span className="font-mono text-[11px] text-forest-800">
        {item.field}
      </span>
      <span className="block text-[12px] leading-snug text-forest-800/70">
        {item.why}
      </span>
    </li>
  );
}
