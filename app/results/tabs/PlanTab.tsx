"use client";

import type {
  Submission,
  SubmissionPersonInput,
  SubmissionProtocolInput,
} from "@/components/ResultsView";
import type { ScheduledTask } from "@/lib/engine/types";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const FAMILY_TONES: Record<string, "moss" | "ocean" | "sand"> = {
  DNA_extraction: "moss",
  PCR: "ocean",
  Bead_cleanup: "sand",
};

export default function PlanTab({ data }: { data: Submission }) {
  const ACCENTS = ["moss", "ocean", "sand"] as const;
  const people = data.people;
  const plan = data.plan;

  return (
    <div className="space-y-8">
      <SectionCard
        eyebrow="Step 1 · Plan"
        title="Here&rsquo;s what we received"
        lede="Each person&rsquo;s protocols get parsed into structured steps, reagents, and timings. Their calendar is treated as a hard busy constraint the scheduler must honor."
      >
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => {
            const p = people[i];
            return (
              <PersonCard
                key={i}
                index={i}
                accent={ACCENTS[i]}
                person={p ?? null}
              />
            );
          })}
        </div>
      </SectionCard>

      <StageBlockView
        weekStartIso={plan.week_start_iso}
        people={people}
        schedule={plan.schedule}
        unscheduled={plan.diagnostics.unscheduled}
        warnings={plan.diagnostics.warnings}
      />
    </div>
  );
}

/* ---------- Per-person card (left side: input mirror) ---------- */

function PersonCard({
  index,
  accent,
  person,
}: {
  index: number;
  accent: "moss" | "ocean" | "sand";
  person: SubmissionPersonInput | null;
}) {
  const badge =
    accent === "moss"
      ? "bg-moss-100 text-moss-700"
      : accent === "ocean"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-200 text-clay-600";

  const empty =
    !person ||
    (!person.name &&
      !person.schedule_filename &&
      person.protocols.every((p) => !p.filename));
  const totalSamples =
    person?.protocols.reduce((n, p) => n + (p.sample_count || 0), 0) ?? 0;

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
              {person?.name || (
                <span className="text-forest-800/40">— not provided</span>
              )}
            </p>
          </div>
        </div>
        {totalSamples > 0 && (
          <span className="rounded-full bg-forest-700/10 px-3 py-1 text-[11px] font-semibold text-forest-800">
            {totalSamples} {totalSamples === 1 ? "sample" : "samples"} total
          </span>
        )}
      </div>
      <ul className="space-y-2 text-xs">
        <ScheduleRow
          filename={person?.schedule_filename ?? null}
          size={person?.schedule_size ?? null}
        />
        {(person?.protocols ?? []).map((entry, i) => (
          <ProtocolRowCard key={i} entry={entry} />
        ))}
      </ul>
    </div>
  );
}

function ScheduleRow({
  filename,
  size,
}: {
  filename: string | null;
  size: number | null;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-forest-700/10 bg-white/70 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-ocean-400" />
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-forest-800/55">
            Schedule (.ics)
          </p>
          <p className="truncate font-medium text-forest-800">
            {filename ?? (
              <span className="text-forest-800/40">— not provided</span>
            )}
          </p>
        </div>
      </div>
      {size && (
        <span className="shrink-0 text-[11px] text-forest-800/50">
          {(size / 1024).toFixed(1)} KB
        </span>
      )}
    </li>
  );
}

function ProtocolRowCard({ entry }: { entry: SubmissionProtocolInput }) {
  const matched = entry.matched_protocol_name;
  return (
    <li className="rounded-xl border border-forest-700/10 bg-white/70 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-moss-500" />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-forest-800/55">
              Protocol · {entry.sample_count} samples
            </p>
            <p className="truncate font-medium text-forest-800">
              {entry.filename}
            </p>
            {matched && (
              <p className="mt-1 truncate text-[11px] text-moss-700">
                → {matched}
              </p>
            )}
          </div>
        </div>
        <MatchBadge
          via={entry.matched_via}
          confidence={entry.match_confidence}
        />
      </div>
    </li>
  );
}

function MatchBadge({
  via,
  confidence,
}: {
  via: SubmissionProtocolInput["matched_via"];
  confidence: number;
}) {
  if (via === "none") {
    return (
      <span className="shrink-0 rounded-full bg-clay-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-clay-600">
        no match
      </span>
    );
  }
  const cls =
    via === "filename"
      ? "bg-moss-100 text-moss-700"
      : via === "keyword"
      ? "bg-ocean-100 text-ocean-700"
      : "bg-sand-200 text-clay-600";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${cls}`}
      title={`Matched via ${via} at ${(confidence * 100).toFixed(0)}% confidence`}
    >
      {via} · {(confidence * 100).toFixed(0)}%
    </span>
  );
}

/* ---------- Stage block view (right side: real schedule) ---------- */

function StageBlockView({
  weekStartIso,
  people,
  schedule,
  unscheduled,
  warnings,
}: {
  weekStartIso: string;
  people: SubmissionPersonInput[];
  schedule: ScheduledTask[];
  unscheduled: { task_id: string; reason: string }[];
  warnings: string[];
}) {
  const weekStart = new Date(weekStartIso);
  const dayKeys: number[] = [0, 1, 2, 3, 4]; // Mon–Fri default
  // Surface weekend columns only if any task lands there.
  const hasSat = schedule.some((s) => dayIndex(s.start_iso, weekStart) === 5);
  const hasSun = schedule.some((s) => dayIndex(s.start_iso, weekStart) === 6);
  if (hasSat) dayKeys.push(5);
  if (hasSun) dayKeys.push(6);

  const peopleNames = people
    .map((p) => p.name?.trim() || "")
    .filter((n, i) => n || people[i].protocols.length > 0);

  const weekStartLabel = weekStart.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <SectionCard
      eyebrow="Week outline"
      title="Real schedule from the engine"
      lede={`Block placement reflects parsed protocol durations, equipment availability, and the busy intervals from each person's uploaded calendar. Week starts ${weekStartLabel}.`}
    >
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
              {DAY_LABELS[d]}
            </div>
          ))}

          {peopleNames.length === 0 ? (
            <div
              className="border-t border-forest-700/10 px-4 py-6 text-sm text-forest-800/55"
              style={{ gridColumn: `1 / span ${dayKeys.length + 1}` }}
            >
              No people in this submission.
            </div>
          ) : (
            peopleNames.map((name) => {
              const personTasks = schedule.filter(
                (s) => s.person === name
              );
              return (
                <PersonRow
                  key={name}
                  name={name || "(unnamed)"}
                  dayKeys={dayKeys}
                  weekStart={weekStart}
                  tasks={personTasks}
                />
              );
            })
          )}
        </div>
      </div>

      {(unscheduled.length > 0 || warnings.length > 0) && (
        <div className="mt-5 grid gap-3 text-xs md:grid-cols-2">
          {unscheduled.length > 0 && (
            <div className="rounded-xl border border-clay-400/30 bg-clay-400/10 px-4 py-3 text-clay-700">
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
            <div className="rounded-xl border border-sand-200 bg-sand-100 px-4 py-3 text-clay-600">
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
      )}

      <p className="mt-4 text-xs text-forest-800/55">
        Tones reflect protocol family — moss = extraction, ocean = PCR, sand =
        cleanup. Tasks marked “shared” are batched with at least one other
        person under the Coordinate tab.
      </p>
    </SectionCard>
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
  return (
    <>
      <div className="border-t border-forest-700/10 bg-white/60 px-4 py-5 font-display font-semibold text-forest-800">
        {name}
        {tasks.length === 0 && (
          <p className="mt-1 text-[11px] font-normal text-forest-800/45">
            no tasks scheduled
          </p>
        )}
      </div>
      {dayKeys.map((d) => {
        const dayTasks = tasks
          .filter((s) => dayIndex(s.start_iso, weekStart) === d)
          .sort((a, b) => a.start_iso.localeCompare(b.start_iso));
        return (
          <div
            key={d}
            className="border-l border-t border-forest-700/5 bg-white/60 p-2 first:border-l-0"
          >
            <div className="flex flex-col gap-1.5">
              {dayTasks.map((t) => (
                <Block key={t.task_id} task={t} />
              ))}
            </div>
          </div>
        );
      })}
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
  const startTime = new Date(task.start_iso).toISOString().slice(11, 16);
  const endTime = new Date(task.end_iso).toISOString().slice(11, 16);
  const isShared = task.shared_with.length > 0;
  return (
    <div
      className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${cls}`}
      style={
        isShared
          ? {
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(255,255,255,0.35) 0 8px, transparent 8px 16px)",
            }
          : undefined
      }
      title={`${task.protocol_name}\n${startTime}–${endTime} UTC\n${task.duration_min} min${
        isShared ? `\nShared with: ${task.shared_with.join(", ")}` : ""
      }`}
    >
      <p className="truncate">{shortProtocol(task.protocol_name)}</p>
      <p className="mt-0.5 text-[10px] font-normal opacity-80">
        {startTime} · {task.duration_min}m{isShared && " · shared"}
      </p>
    </div>
  );
}

function shortProtocol(name: string): string {
  // The 9 seeded protocol names are long; trim to the recognizable head.
  if (name.length <= 26) return name;
  return name.slice(0, 24) + "…";
}

function dayIndex(iso: string, weekStart: Date): number {
  const ms = new Date(iso).getTime() - weekStart.getTime();
  if (ms < 0) return -1;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/* ---------- shared building block (also exported for CoordinateTab) ---------- */

export function SectionCard({
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
