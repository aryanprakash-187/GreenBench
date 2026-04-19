"use client";

import type { Submission } from "@/components/ResultsView";

export default function PlanTab({ data }: { data: Submission | null }) {
  const people = data?.people ?? [];
  const ACCENTS = ["moss", "ocean", "sand"] as const;

  return (
    <div className="space-y-8">
      <SectionCard
        eyebrow="Step 1 · Plan"
        title="Here&rsquo;s what we received"
        lede="Each person&rsquo;s protocol gets parsed into structured steps, reagents, and timings. Their calendar is treated as a hard busy constraint the scheduler must honor."
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

      <SectionCard
        eyebrow="Week outline"
        title="How we&rsquo;ll plan this"
        lede="Each person&rsquo;s row shows protocols placed in free slots across a 3–7 day horizon. Protocol dependencies are honored — extraction finishes before the PCR that consumes it."
      >
        <div className="overflow-hidden rounded-xl border border-forest-700/10">
          <div className="grid grid-cols-[140px_repeat(5,1fr)] bg-forest-700/5 text-[11px] uppercase tracking-[0.18em] text-forest-800/60">
            <div className="px-4 py-3">Operator</div>
            {["Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => (
              <div key={d} className="px-4 py-3">
                {d}
              </div>
            ))}
          </div>
          {[0, 1, 2].map((i) => {
            const personName = people[i]?.name?.trim() || `Person ${i + 1}`;
            const blocks =
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
                : [{ day: 4, label: "PCR", tone: "ocean" as const }];
            return (
              <div
                key={i}
                className="grid grid-cols-[140px_repeat(5,1fr)] border-t border-forest-700/10 bg-white/60"
              >
                <div className="border-r border-forest-700/10 px-4 py-5 font-display font-semibold text-forest-800">
                  {personName}
                </div>
                {[0, 1, 2, 3, 4].map((day) => {
                  const b = blocks.find((x) => x.day === day);
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
            );
          })}
        </div>
        <p className="mt-4 text-xs text-forest-800/55">
          This is a mockup of the stage-block view. Once connected to the
          engine, block placement reflects parsed protocol durations, equipment
          availability, and busy ICS constraints.
        </p>
      </SectionCard>
    </div>
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
  protocol: { name: string; size: number } | null;
  schedule: { name: string; size: number } | null;
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
  file: { name: string; size: number } | null;
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
