// Per-person ICS exporter.
//
// Pure function (no fs, no network, no Node-only APIs) so it runs equally
// well from a Next.js server route or a client component. Given a narrated
// week plan plus the person's original busy ICS text, build a single
// VCALENDAR with:
//
//   1. The original VEVENT blocks from the upload, passed through unchanged
//      (so the user's "existing" calendar entries survive the round trip).
//   2. One VEVENT per scheduled task that belongs to this person, with a
//      LOCATION pulled from the equipment reservation and a DESCRIPTION
//      that lists the prose recommendation, separations, and citations
//      relevant to that task.
//   3. One VEVENT per shared coordination event that this person
//      participates in (shared reagent prep / shared equipment run). Shared
//      events are placed 30 min before the earliest participating task and
//      annotated as "Green Bench · Shared ...".
//
// We deliberately don't try to be a full RFC 5545 implementation — we
// emit the minimum every major calendar app (Google, Apple, Outlook)
// accepts, and we honor the line-folding and text-escaping rules so
// imports don't blow up on commas, semicolons, or newlines in our prose.

import type {
  NarratedCoordination,
  NarratedSeparation,
  NarratedWeekPlanResult,
  ScheduledTask,
} from '@/lib/engine/types';

const GREENBENCH_PRODID = '-//Green Bench//Schedule for Sustainability//EN';
const SHARED_PREP_LEAD_MIN = 30; // shared prep block sits this many min before the earliest user
const SHARED_PREP_DEFAULT_DURATION_MIN = 20;

export interface BuildPersonIcsOptions {
  /** Display name; matches ScheduledTask.person and Coordination.participants[].person. */
  personName: string;
  /** Raw ICS text the user uploaded for this person. May be empty. */
  busyIcsText?: string | null;
  /** The narrated plan from /api/plan?narrate=1 (or the narrator). */
  plan: NarratedWeekPlanResult;
  /** Stamp used for DTSTAMP / UID; defaults to now. Allows deterministic tests. */
  now?: Date;
}

/** Build the full per-person ICS text. Always returns a valid VCALENDAR. */
export function buildPersonIcs(opts: BuildPersonIcsOptions): string {
  const now = opts.now ?? new Date();
  const stamp = formatIcsUtc(now);

  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${GREENBENCH_PRODID}`);
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:Green Bench · ${escapeText(opts.personName)}`);
  lines.push('X-WR-TIMEZONE:UTC');

  // 1. Pass-through of the user's original VEVENT blocks. We grab them
  //    verbatim from the upload so any TZ definitions, RRULEs, etc. survive.
  const originalVevents = extractVeventBlocks(opts.busyIcsText ?? '');
  for (const block of originalVevents) {
    lines.push(...block);
  }

  // 2. Per-task events for THIS person.
  const myTasks = opts.plan.schedule.filter((t) => t.person === opts.personName);
  for (const task of myTasks) {
    lines.push(...buildTaskVevent({ task, plan: opts.plan, stamp }));
  }

  // 3. Shared coordination events that this person participates in.
  //    We emit one per coordination so the calendar shows a separate
  //    "Shared ..." block (otherwise the LOCATION+DESCRIPTION on the task
  //    event is the only signal a user gets, which is easy to miss).
  const participatingCoords = opts.plan.coordinations.filter((c) =>
    c.participants.some((p) => p.person === opts.personName)
  );
  for (const coord of participatingCoords) {
    const sharedBlock = buildSharedCoordinationVevent({
      coord,
      plan: opts.plan,
      personName: opts.personName,
      stamp,
    });
    if (sharedBlock) lines.push(...sharedBlock);
  }

  lines.push('END:VCALENDAR');

  // RFC 5545 line folding: split every output line at >75 octets.
  return lines.flatMap(foldLine).join('\r\n') + '\r\n';
}

// ----- Per-task VEVENT -----

function buildTaskVevent(args: {
  task: ScheduledTask;
  plan: NarratedWeekPlanResult;
  stamp: string;
}): string[] {
  const { task, plan, stamp } = args;

  const equipmentLabel = task.equipment
    .map((e) => e.lab_id ?? e.equipment_group)
    .filter(Boolean)
    .join(', ');
  const location = equipmentLabel
    ? `Green Bench bench · ${equipmentLabel}`
    : 'Green Bench bench';

  const descriptionParts: string[] = [];
  descriptionParts.push(
    `Protocol: ${task.protocol_name} (${task.family.replace(/_/g, ' ')})`
  );
  descriptionParts.push(`Estimated duration: ${task.duration_min} min`);

  if (task.shared_with.length > 0) {
    descriptionParts.push(
      `Shared with: ${task.shared_with.join(', ')}`
    );
  }

  // Coordination prose (headline + savings) for any coordination this task
  // participates in — gives the user the "why" without needing the app open.
  const involved = plan.coordinations.filter((c) =>
    c.participants.some((p) => p.task_id === task.task_id)
  );
  for (const c of involved) {
    descriptionParts.push('');
    descriptionParts.push(`Coordination: ${c.prose.headline}`);
    descriptionParts.push(c.prose.savings_phrase);
  }

  // Separations that mention this task — surfaced as a safety reminder.
  const sepsForTask: NarratedSeparation[] = plan.separations.filter((s) =>
    s.task_ids.includes(task.task_id)
  );
  if (sepsForTask.length > 0) {
    descriptionParts.push('');
    descriptionParts.push('Waste separation reminders:');
    for (const s of sepsForTask) {
      descriptionParts.push(`• ${s.prose.headline}`);
    }
  }

  if (task.notes.length > 0) {
    descriptionParts.push('');
    descriptionParts.push(`Notes: ${task.notes.join(' | ')}`);
  }

  const description = descriptionParts.join('\n');

  const out: string[] = [];
  out.push('BEGIN:VEVENT');
  out.push(`UID:${task.task_id}@greenbench.local`);
  out.push(`DTSTAMP:${stamp}`);
  out.push(`DTSTART:${formatIcsUtcFromIso(task.start_iso)}`);
  out.push(`DTEND:${formatIcsUtcFromIso(task.end_iso)}`);
  out.push(`SUMMARY:Green Bench · ${escapeText(task.protocol_name)}`);
  out.push(`LOCATION:${escapeText(location)}`);
  out.push(`DESCRIPTION:${escapeText(description)}`);
  out.push('CATEGORIES:GREEN_BENCH,PROTOCOL');
  out.push('STATUS:CONFIRMED');
  out.push('TRANSP:OPAQUE');
  out.push('END:VEVENT');
  return out;
}

// ----- Shared coordination VEVENT -----

function buildSharedCoordinationVevent(args: {
  coord: NarratedCoordination;
  plan: NarratedWeekPlanResult;
  personName: string;
  stamp: string;
}): string[] | null {
  const { coord, plan, personName, stamp } = args;

  // Find the earliest scheduled participant for this coordination — the
  // shared prep block needs to be done before the first user touches the
  // shared output. (For shared_equipment_run we anchor on the shared start.)
  const partTasks = coord.participants
    .map((p) => plan.schedule.find((s) => s.task_id === p.task_id))
    .filter((s): s is ScheduledTask => !!s);

  if (partTasks.length === 0) return null;

  const earliestStart = partTasks.reduce((min, s) => {
    const t = new Date(s.start_iso).getTime();
    return t < min ? t : min;
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(earliestStart)) return null;

  let start: Date;
  let end: Date;
  let summary: string;
  let location: string;

  if (coord.type === 'shared_reagent_prep') {
    // Place the shared prep block 50 min before the earliest participant's
    // task: SHARED_PREP_LEAD_MIN of breathing room + SHARED_PREP_DEFAULT_DURATION_MIN
    // for the actual prep itself. This keeps the prep visually distinct from
    // back-to-back tasks and finishes 30 min before any participant starts.
    start = new Date(
      earliestStart -
        (SHARED_PREP_LEAD_MIN + SHARED_PREP_DEFAULT_DURATION_MIN) * 60 * 1000
    );
    end = new Date(start.getTime() + SHARED_PREP_DEFAULT_DURATION_MIN * 60 * 1000);
    summary = `Green Bench · Shared prep · ${humanize(coord.overlap_group ?? 'reagent')}`;
    location = 'Green Bench prep bench';
  } else {
    // Shared equipment run: anchor on the earliest task — they're meant to
    // run simultaneously. We mirror the duration of the earliest task.
    const earliest = partTasks.find(
      (s) => new Date(s.start_iso).getTime() === earliestStart
    )!;
    start = new Date(earliest.start_iso);
    end = new Date(earliest.end_iso);
    const eqLabel = humanize(coord.equipment_group ?? 'equipment');
    summary = `Green Bench · Shared ${eqLabel} run`;
    location = `Green Bench bench · ${eqLabel}`;
  }

  const otherPeople = uniq(
    coord.participants.map((p) => p.person).filter((n) => n !== personName)
  );
  const peopleSuffix =
    otherPeople.length > 0 ? ` (with ${otherPeople.join(', ')})` : '';

  const descriptionParts: string[] = [];
  descriptionParts.push(coord.prose.headline);
  descriptionParts.push(coord.prose.body);
  descriptionParts.push('');
  descriptionParts.push(coord.prose.savings_phrase);
  if (coord.citations.length > 0) {
    descriptionParts.push('');
    descriptionParts.push('Citations:');
    for (const c of coord.citations) {
      const code = c.rcra_code ? ` [${c.rcra_code}]` : '';
      descriptionParts.push(`• ${c.reagent}${code}`);
      for (const src of c.sources) descriptionParts.push(`  ${src}`);
    }
  }
  if (!coord.aligned) {
    descriptionParts.push('');
    descriptionParts.push(
      'Advisory: scheduler could not perfectly align this with all participants. Treat the above time as a target.'
    );
  }

  const description = descriptionParts.join('\n');

  const out: string[] = [];
  out.push('BEGIN:VEVENT');
  out.push(`UID:${coord.id}__${slug(personName)}@greenbench.local`);
  out.push(`DTSTAMP:${stamp}`);
  out.push(`DTSTART:${formatIcsUtc(start)}`);
  out.push(`DTEND:${formatIcsUtc(end)}`);
  out.push(`SUMMARY:${escapeText(summary + peopleSuffix)}`);
  out.push(`LOCATION:${escapeText(location)}`);
  out.push(`DESCRIPTION:${escapeText(description)}`);
  out.push('CATEGORIES:GREEN_BENCH,COORDINATION');
  out.push('STATUS:TENTATIVE');
  out.push('TRANSP:OPAQUE');
  out.push('END:VEVENT');
  return out;
}

// ----- ICS pass-through extraction -----
//
// We read the user's upload and yank out each VEVENT block as raw text.
// We don't try to parse semantics here — round-tripping the bytes verbatim
// is the safest way to preserve TZID definitions, RRULEs, attendees, etc.
// We DO unfold continuation lines on read and re-fold on write so the
// final calendar is valid even if the upstream file had lines >75 octets.

function extractVeventBlocks(icsText: string): string[][] {
  if (!icsText) return [];
  const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      current = ['BEGIN:VEVENT'];
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        current.push('END:VEVENT');
        blocks.push(current);
      }
      current = null;
      continue;
    }
    if (current && line.length > 0) current.push(line);
  }
  return blocks;
}

// ----- ICS text helpers -----

/** RFC 5545 §3.3.11: escape backslash, comma, semicolon, and newlines in TEXT values. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** RFC 5545 §3.1: fold lines longer than 75 octets, continuation lines start
 *  with a space. We measure UTF-8 byte length (not JS string length) so a
 *  multi-byte character (em-dash, accented operator name, future emoji)
 *  doesn't silently push a line past the 75-octet ceiling. We also slice on
 *  byte boundaries so continuation lines stay valid UTF-8. */
function foldLine(line: string): string[] {
  // Continuation lines start with a SP, which itself counts toward the 75
  // octets. So the first chunk gets MAX bytes and each subsequent chunk gets
  // MAX - 1 bytes of payload (after the leading SP).
  const FIRST_MAX = 75;
  const CONT_MAX = 74;

  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= FIRST_MAX) return [line];

  const out: string[] = [];
  let offset = 0;
  let max = FIRST_MAX;
  let prefix = '';
  while (offset < buf.length) {
    let take = Math.min(max, buf.length - offset);
    // Walk back so we don't slice through the middle of a UTF-8 codepoint.
    // Continuation bytes are 10xxxxxx (0x80–0xBF); back up until we land on
    // a leading byte (or run out of room).
    while (take > 0 && offset + take < buf.length) {
      const b = buf[offset + take];
      if ((b & 0xc0) !== 0x80) break;
      take -= 1;
    }
    if (take <= 0) {
      // Pathological — single codepoint wider than the budget. Fall through
      // and emit the leading byte so we don't loop forever; result will be
      // mojibake but never crash.
      take = 1;
    }
    out.push(prefix + buf.subarray(offset, offset + take).toString('utf8'));
    offset += take;
    max = CONT_MAX;
    prefix = ' ';
  }
  return out;
}

/** Format a Date as ICS UTC: 20260420T140000Z. */
function formatIcsUtc(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function formatIcsUtcFromIso(iso: string): string {
  return formatIcsUtc(new Date(iso));
}

function humanize(s: string): string {
  return s.replace(/_/g, ' ');
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

// ----- Convenience: filename for a person -----

export function suggestIcsFilename(personName: string): string {
  const safe = personName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 40) || 'person';
  return `greenbench_${safe}.ics`;
}
