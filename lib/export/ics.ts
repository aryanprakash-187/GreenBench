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
//   3. One VEVENT per shared *reagent prep* coordination this person
//      participates in. Multiple preps anchored to the same task are
//      staggered (prep[0] ends 30 min before the task, each earlier prep
//      nests another DURATION+GAP minutes back) so a single human can
//      realistically execute them sequentially.
//
// We intentionally do NOT emit a VEVENT for shared_equipment_run
// coordinations: by construction every participant of an equipment-share
// already owns a task event at that time, with the equipment listed in
// LOCATION and the partner in "Shared with:". Re-emitting a same-time
// "Shared X run" block on top of the task event creates pure visual
// noise with no extra information. We also defensively skip any
// coordination whose savings are all zero — those are advisory cards in
// the overview, not real calendar events.
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
const SHARED_PREP_LEAD_MIN = 30; // first prep block ends this many min before the earliest user task
const SHARED_PREP_DEFAULT_DURATION_MIN = 20;
const SHARED_PREP_STAGGER_GAP_MIN = 5; // breathing room between back-to-back staggered preps

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
  // We deliberately do NOT emit X-WR-TIMEZONE. This non-standard header is
  // honored by Google Calendar (and partially by Apple) as "interpret every
  // naive DTSTART/DTEND in this calendar as being in this zone". The user's
  // pass-through events are typically RFC 5545 floating times (no Z, no
  // TZID) — they're meant to render at that wall-clock value in whatever
  // timezone the viewer is sitting in. Declaring X-WR-TIMEZONE:UTC made
  // Google reinterpret a 10:00:00 floating event as 10:00 UTC and shift it
  // by the viewer's offset (e.g. 3am in GMT-7), which is wrong. Engine-
  // emitted Green Bench events use explicit `Z` UTC times so they convert
  // correctly with or without the header.

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

  // 3. Shared *reagent prep* coordinations this person participates in.
  //    See file header for why shared_equipment_run is intentionally
  //    excluded. We also drop coordinations with no real net savings
  //    (e.g. equipment shares clamped to runs_saved=0 by capacity math
  //    upstream) — those exist in the engine output as advisory cards
  //    but have no business as calendar blocks.
  //
  //    For the surviving reagent preps we group by their anchor task's
  //    earliest start so we can stagger sibling preps back-to-back. A
  //    single human cannot prep three reagents simultaneously, and the
  //    previous behaviour stacked them all in the same 20-min slot.
  type PrepEntry = { coord: NarratedCoordination; earliestStart: number };
  const prepBuckets = new Map<number, PrepEntry[]>();
  for (const coord of opts.plan.coordinations) {
    if (!coord.participants.some((p) => p.person === opts.personName)) continue;
    if (coord.type !== 'shared_reagent_prep') continue;
    if (!coordinationHasNonzeroSavings(coord)) continue;
    const earliestStart = earliestParticipantStartMs(coord, opts.plan);
    if (earliestStart === null) continue;
    const list = prepBuckets.get(earliestStart) ?? [];
    list.push({ coord, earliestStart });
    prepBuckets.set(earliestStart, list);
  }

  for (const entries of prepBuckets.values()) {
    // Stable order so the same plan produces the same staggered layout
    // every time (deterministic ICS for tests + diff-friendly exports).
    entries.sort((a, b) => a.coord.id.localeCompare(b.coord.id));
    for (let i = 0; i < entries.length; i++) {
      const { coord, earliestStart } = entries[i];
      const startOffsetMin =
        SHARED_PREP_LEAD_MIN +
        SHARED_PREP_DEFAULT_DURATION_MIN +
        i * (SHARED_PREP_DEFAULT_DURATION_MIN + SHARED_PREP_STAGGER_GAP_MIN);
      const start = new Date(earliestStart - startOffsetMin * 60 * 1000);
      const end = new Date(start.getTime() + SHARED_PREP_DEFAULT_DURATION_MIN * 60 * 1000);
      lines.push(
        ...buildSharedReagentPrepVevent({
          coord,
          start,
          end,
          personName: opts.personName,
          stamp,
        })
      );
    }
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

  // Coordinations this task participates in, surfaced as both a peer-list
  // summary and per-coordination prose. We resolve each coordination's
  // participants back to *person names* (not opaque task_ids) so the
  // "Shared with:" line is actually human-readable in Google / Apple /
  // Outlook calendar apps.
  const involved = plan.coordinations.filter((c) =>
    c.participants.some((p) => p.task_id === task.task_id)
  );

  const peerNames = new Set<string>();
  for (const c of involved) {
    for (const p of c.participants) {
      if (p.person !== task.person) peerNames.add(p.person);
    }
  }
  if (peerNames.size > 0) {
    descriptionParts.push(
      `Shared with: ${Array.from(peerNames).join(', ')}`
    );
  }

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
  out.push(`DTSTART:${formatIcsFloatingFromIso(task.start_iso)}`);
  out.push(`DTEND:${formatIcsFloatingFromIso(task.end_iso)}`);
  out.push(`SUMMARY:Green Bench · ${escapeText(task.protocol_name)}`);
  out.push(`LOCATION:${escapeText(location)}`);
  out.push(`DESCRIPTION:${escapeText(description)}`);
  out.push('CATEGORIES:GREEN_BENCH,PROTOCOL');
  out.push('STATUS:CONFIRMED');
  out.push('TRANSP:OPAQUE');
  out.push('END:VEVENT');
  return out;
}

// ----- Shared reagent prep VEVENT -----

function buildSharedReagentPrepVevent(args: {
  coord: NarratedCoordination;
  start: Date;
  end: Date;
  personName: string;
  stamp: string;
}): string[] {
  const { coord, start, end, personName, stamp } = args;

  const summary = `Green Bench · Shared prep · ${humanize(coord.overlap_group ?? 'reagent')}`;
  const location = 'Green Bench prep bench';

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
  out.push(`DTSTART:${formatIcsFloating(start)}`);
  out.push(`DTEND:${formatIcsFloating(end)}`);
  out.push(`SUMMARY:${escapeText(summary + peopleSuffix)}`);
  out.push(`LOCATION:${escapeText(location)}`);
  out.push(`DESCRIPTION:${escapeText(description)}`);
  out.push('CATEGORIES:GREEN_BENCH,COORDINATION');
  out.push('STATUS:TENTATIVE');
  out.push('TRANSP:OPAQUE');
  out.push('END:VEVENT');
  return out;
}

// ----- Coordination filtering helpers -----

/** Earliest scheduled-task start (in ms) across this coordination's participants,
 *  or null if none of the participant tasks are actually in the schedule. */
function earliestParticipantStartMs(
  coord: NarratedCoordination,
  plan: NarratedWeekPlanResult
): number | null {
  const partTasks = coord.participants
    .map((p) => plan.schedule.find((s) => s.task_id === p.task_id))
    .filter((s): s is ScheduledTask => !!s);
  if (partTasks.length === 0) return null;
  const earliest = partTasks.reduce((min, s) => {
    const t = new Date(s.start_iso).getTime();
    return t < min ? t : min;
  }, Number.POSITIVE_INFINITY);
  return Number.isFinite(earliest) ? earliest : null;
}

/** True iff the coordination claims any concrete saving. The matcher can
 *  emit zero-savings shared_equipment_run entries when combined samples
 *  blow past instrument capacity (e.g. 900 samples on a 96-well magnet);
 *  those are useful as overview advisories but have no place on a calendar. */
function coordinationHasNonzeroSavings(coord: NarratedCoordination): boolean {
  const s = coord.savings;
  if ((s.runs_saved ?? 0) > 0) return true;
  if ((s.prep_events_saved ?? 0) > 0) return true;
  if ((s.volume_ml ?? 0) > 0) return true;
  if ((s.hazardous_disposal_events_avoided ?? 0) > 0) return true;
  if (s.co2e_kg_range && (s.co2e_kg_range[0] > 0 || s.co2e_kg_range[1] > 0)) return true;
  return false;
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

/** Format a Date as ICS UTC: 20260420T140000Z. Used for DTSTAMP only —
 *  RFC 5545 §3.8.7.2 requires DTSTAMP to be UTC. Event start/end use the
 *  floating-time formatter below. */
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

/** Format a Date's UTC components as RFC 5545 floating time:
 *  20260420T140000 (no trailing Z, no TZID parameter).
 *
 *  Why floating: the engine reasons about all naive input ICS times as if
 *  they were UTC (lib/engine/ics.ts) and emits scheduled tasks as ISO UTC.
 *  But the input ICS times are typically the user's local wall-clock times
 *  (e.g. "Chem Lecture at 10:00" means 10am wherever Sohini lives, not
 *  10:00 UTC). So when we hand the result back to a calendar viewer we
 *  emit floating time too — the viewer renders the digits at face value
 *  in its local zone. Round-trip stays consistent for a single-timezone
 *  lab, which is the realistic deployment.
 *
 *  Multi-timezone collaboration would need real TZID handling end-to-end
 *  (see TODO in lib/engine/ics.ts). */
function formatIcsFloating(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function formatIcsFloatingFromIso(iso: string): string {
  return formatIcsFloating(new Date(iso));
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
