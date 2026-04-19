// Zod schemas for everything the LLM emits.
//
// Why zod here: Gemini returns JSON, but the SDK gives it to us as `unknown`.
// We need a hard parse step before any of it reaches the engine. A schema mismatch
// = a thrown error = the matcher falls back to its deterministic tiers.
//
// Schemas mirror the runtime types in /lib/engine/types.ts. When the engine types
// change, these must change with them — the duplication is intentional so the
// LLM contract is explicit and reviewable in one place.

import { z } from 'zod';

import { loadProtocols } from '../engine/data';

/** Build the enum of valid protocol_name values from the seed CSV at module load.
 *  This is what makes hallucination structurally impossible: the LLM's response
 *  schema literally cannot accept a 10th protocol. */
function protocolNameEnum() {
  const names = loadProtocols().map((p) => p.protocol_name);
  if (names.length === 0) {
    throw new Error('protocols_selected.csv is empty — cannot build LLM schema.');
  }
  // zod v4: z.enum accepts a readonly tuple of literals. We assert the tuple shape
  // since the CSV gives us a runtime-derived array.
  return z.enum(names as unknown as readonly [string, ...string[]]);
}

/** Lazily memoized so importing this module doesn't trigger a CSV read until needed. */
let _matchSchema: ReturnType<typeof buildMatchSchema> | null = null;

function buildMatchSchema() {
  const ProtocolName = protocolNameEnum();
  return z.object({
    protocol_name: ProtocolName,
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string()).min(1).max(5),
  });
}

export function protocolMatchSchema() {
  if (!_matchSchema) _matchSchema = buildMatchSchema();
  return _matchSchema;
}

/** The shape the LLM is asked to return. Kept narrow on purpose: we don't ask for
 *  candidates, we ask for the single best match plus reasoning. The deterministic
 *  matcher in matchProtocol.ts is what tracks candidates across all tiers. */
export interface LLMProtocolMatchResponse {
  protocol_name: string;
  confidence: number;
  reasons: string[];
}

/** Convenience: response schema as a JSON-Schema-ish object suitable for Gemini's
 *  `responseSchema` parameter. Gemini supports a subset of OpenAPI 3.0; enums
 *  and required fields are honored. */
export function geminiResponseSchemaForMatch() {
  const protocolNames = loadProtocols().map((p) => p.protocol_name);
  return {
    type: 'object',
    properties: {
      protocol_name: {
        type: 'string',
        enum: protocolNames,
        description:
          'The exact protocol_name from the curated catalog of 9 protocols. Must match one of the enum values verbatim.',
      },
      confidence: {
        type: 'number',
        description:
          'Calibrated 0..1 estimate. >0.8 = clear vendor + product cues. 0.5..0.8 = inferred from technique. <0.5 = guess.',
      },
      reasons: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 short evidence snippets ("vendor name on cover", "Q5 master mix in step 3", etc.).',
      },
    },
    required: ['protocol_name', 'confidence', 'reasons'],
  } as const;
}

// ----- Narrator (Layer 4) schemas -----
//
// The narrator returns one object per WeekPlanResult containing:
//   - headline_tagline: a single sentence for the top of the impact card
//   - coordinations[]: parallel-indexed array of prose, one per input coordination
//   - separations[]:   parallel-indexed array of prose, one per input separation
//
// "Parallel-indexed" = the i-th item in the response describes the i-th item
// in the request. Position is the join key, not name. This kills an entire
// class of "the LLM renamed coord_3 to coord_three" failure modes.

const HEADLINE_MAX = 90;
const BODY_MAX = 280;

/** Light heuristic to keep the model from emitting hand-wavy savings phrases
 *  like "many" or "several". Real numbers come from coordination.savings. */
const SAVINGS_PHRASE_REGEX = /\d/;

const coordinationProseSchema = z.object({
  headline: z.string().min(1).max(HEADLINE_MAX),
  body: z.string().min(1).max(BODY_MAX),
  savings_phrase: z
    .string()
    .min(1)
    .max(HEADLINE_MAX)
    .refine((s) => SAVINGS_PHRASE_REGEX.test(s), {
      message: 'savings_phrase must contain at least one digit',
    }),
});

const separationProseSchema = z.object({
  headline: z.string().min(1).max(HEADLINE_MAX),
  body: z.string().min(1).max(BODY_MAX),
});

/** Build a top-level narration schema parameterized by the expected array
 *  lengths. Length-locking the arrays lets us fail fast if Gemini drops or
 *  duplicates an item — the join key is position, so wrong length = wrong
 *  output. */
export function narrationResponseSchema(
  coordinationCount: number,
  separationCount: number
) {
  return z.object({
    headline_tagline: z.string().min(1).max(160),
    coordinations: z
      .array(coordinationProseSchema)
      .length(coordinationCount),
    separations: z
      .array(separationProseSchema)
      .length(separationCount),
  });
}

export type LLMNarrationResponse = z.infer<
  ReturnType<typeof narrationResponseSchema>
>;

/** Gemini-side response schema. The SDK accepts a subset of OpenAPI 3.0; we
 *  cannot assert exact array length there (Gemini ignores `minItems`/`maxItems`
 *  in practice on Flash), so we enforce length zod-side after parsing. */
export function geminiResponseSchemaForNarrate() {
  const proseObject = (extraDescription: string) => ({
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: `Short title (≤${HEADLINE_MAX} chars). ${extraDescription}`,
      },
      body: {
        type: 'string',
        description: `1–3 sentences (≤${BODY_MAX} chars). Names the people, days, and the specific reagent or equipment.`,
      },
    },
    required: ['headline', 'body'],
  });

  return {
    type: 'object',
    properties: {
      headline_tagline: {
        type: 'string',
        description:
          'One short sentence summarizing the week-level impact. Mention the people if 1–3 are named in the input.',
      },
      coordinations: {
        type: 'array',
        description:
          'Prose for each coordination, in the SAME ORDER as the input. Length must equal the number of input coordinations.',
        items: {
          type: 'object',
          properties: {
            headline: {
              type: 'string',
              description: `Action-oriented title (≤${HEADLINE_MAX} chars). E.g. "Prep 60 mL of 70% ethanol once Monday morning".`,
            },
            body: {
              type: 'string',
              description: `Why and how (≤${BODY_MAX} chars). Names the people, days, and reagent or equipment.`,
            },
            savings_phrase: {
              type: 'string',
              description:
                'Plain-English savings sentence. Must contain at least one numeric value, taken from the input savings field. Do not invent numbers.',
            },
          },
          required: ['headline', 'body', 'savings_phrase'],
        },
      },
      separations: {
        type: 'array',
        description:
          'Prose for each separation warning, in the SAME ORDER as the input. Length must equal the number of input separations.',
        items: proseObject(
          'Imperative warning, e.g. "Buffer AL waste must not mix with bleach".'
        ),
      },
    },
    required: ['headline_tagline', 'coordinations', 'separations'],
  } as const;
}

/** Reset memoized schema. Useful for tests when the seed CSV changes. */
export function __resetSchemaCache(): void {
  _matchSchema = null;
}
