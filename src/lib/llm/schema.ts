/**
 * The query schema.
 *
 * The single most important design decision in the parser (plan section 3, [1])
 * is the split between what is FILTERABLE and what is SEMANTIC. "100 BPM" is a
 * number and belongs in a WHERE clause; "cavernous" is a vibe and belongs in an
 * embedding. Conflating them is how these systems fail: either the vibe text
 * gets keyword-matched against titles, or the hard constraint gets softened into
 * a similarity score and quietly violated.
 *
 * Every field is present and nullable rather than optional, because strict JSON
 * schema mode on both providers requires every property to appear in `required`.
 */

import { z } from 'zod';

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const MODE_NAMES = [
  'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian',
  'locrian', 'harmonic_minor', 'phrygian_dominant', 'whole_tone',
] as const;

const num = z.number().nullable();
const int = z.number().int().nullable();

export const ParsedQuerySchema = z.object({
  bpm_min: num,
  bpm_max: num,
  tonics: z.array(z.enum(PITCH_NAMES)).nullable(),
  modes: z.array(z.enum(MODE_NAMES)).nullable(),
  instrumental: z.boolean().nullable(),
  year_min: int,
  year_max: int,
  emergence_max: num,
  energy_min: num,
  energy_max: num,
  brightness_min: num,
  brightness_max: num,
  duration_min: num,
  duration_max: num,
  tags: z.array(z.string()).nullable(),
  keywords: z.string().nullable(),
  semantic: z.string(),
  min_mode_confidence: num,
  limit: z.number().int(),
  reasoning: z.string(),
});

export type ParsedQuery = z.infer<typeof ParsedQuerySchema>;

const nullable = (t: string) => ({ type: [t, 'null'] });

/** Hand-written JSON Schema: strict mode on both providers rejects several
 *  keywords that a zod->JSON-Schema converter emits, so this stays explicit. */
export const PARSED_QUERY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'bpm_min', 'bpm_max', 'tonics', 'modes', 'instrumental', 'year_min', 'year_max',
    'emergence_max', 'energy_min', 'energy_max', 'brightness_min', 'brightness_max',
    'duration_min', 'duration_max', 'tags', 'keywords', 'semantic',
    'min_mode_confidence', 'limit', 'reasoning',
  ],
  properties: {
    bpm_min: { ...nullable('number'), description: 'Lower bound on tempo. "around 100 BPM" -> 94.' },
    bpm_max: { ...nullable('number'), description: 'Upper bound on tempo. "around 100 BPM" -> 106.' },
    tonics: { type: ['array', 'null'], items: { type: 'string', enum: PITCH_NAMES }, description: 'Required tonal centres as pitch class names. Only when the user names a key.' },
    modes: { type: ['array', 'null'], items: { type: 'string', enum: MODE_NAMES }, description: 'Required modes. "minor" -> ["aeolian","dorian","phrygian"]; "major" -> ["ionian","lydian","mixolydian"].' },
    instrumental: { ...nullable('boolean'), description: 'true = no vocals required, false = vocals required, null = no preference.' },
    year_min: { ...nullable('integer') },
    year_max: { ...nullable('integer') },
    emergence_max: { ...nullable('number'), description: 'Artist popularity percentile ceiling, 0-100, LOWER IS MORE OBSCURE. "emerging"/"unknown"/"underground" -> 20. "fairly unknown" -> 40. null if unmentioned.' },
    energy_min: { ...nullable('number'), description: '0-1. ONLY when the user explicitly demands intensity ("high energy", "driving", "hard"). Leave null for a genre name alone.' },
    energy_max: { ...nullable('number'), description: '0-1. ONLY when the user explicitly demands calm ("calm", "gentle", "quiet"). A genre that happens to be mellow is NOT an energy constraint.' },
    brightness_min: { ...nullable('number'), description: '0-1 spectral brightness. ONLY for an explicit statement about high-frequency content ("bright", "crisp", "airy").' },
    brightness_max: { ...nullable('number'), description: '0-1. ONLY for an explicit statement about high-frequency content ("dark on top", "muffled", "no top end"). "dark" as a MOOD is not a brightness constraint — that belongs in semantic.' },
    duration_min: { ...nullable('number'), description: 'Seconds.' },
    duration_max: { ...nullable('number'), description: 'Seconds. "short" -> 180.' },
    tags: { type: ['array', 'null'], items: { type: 'string' }, description: 'Style keywords used to BOOST ranking, never to filter. Single words work far better than phrases: prefer ["techno","dub"] over ["dub techno"]. Always also describe the genre in `semantic`.' },
    keywords: { ...nullable('string'), description: 'A literal artist or title fragment the user named. Not for genres or moods.' },
    semantic: { type: 'string', description: 'The TEXTURAL/MOOD part of the query, rewritten as a rich descriptive phrase for embedding. Never include numbers, keys, or constraints already captured above. If the user gave no vibe, describe the implied sound of what they asked for.' },
    min_mode_confidence: { ...nullable('number'), description: '0-1. Set 0.5 ONLY when the user names one specific mode ("Phrygian", "Dorian"). Leave null for a vague "minor"/"major" — it discards more than half the corpus.' },
    limit: { type: 'integer', description: 'How many results, 1-50. Default 20.' },
    reasoning: { type: 'string', description: 'One sentence: which parts you treated as hard constraints and which as vibe.' },
  },
} as const;

export const PARSER_SYSTEM = `You translate natural-language music queries into a strict JSON filter for CRATE, a music search engine that indexes audio by measured signal features.

Your ONLY job is translation into structure. You are not retrieving anything and you must not invent artists, titles, or genres.

HOW MANY CONSTRAINTS TO EMIT: as few as possible. Every typed field you fill is an
inviolable SQL predicate. Three of them intersected will usually return nothing, and an
empty result page is a far worse answer than a loosely-ranked one. The semantic string
costs nothing and can only reorder — so when a word could go either way, it goes there.

GENRE AND STYLE ARE NOT CONSTRAINTS. "techno", "lo-fi hip hop", "trance", "reggae",
"orchestral" describe a sound, and this corpus's tags are self-declared and sparse.
Put the genre in "semantic" as a rich description of how it sounds, and optionally list
single-word style keywords in "tags", which only boosts ranking. Never expect "tags" to
filter, and never use "keywords" for a genre — that field is for a named artist or title.

THE CENTRAL RULE: separate what is measurable from what is a vibe.
  - Measurable -> the typed fields. Tempo, key, mode, year, duration, vocals, obscurity, energy, brightness.
  - Vibe -> the "semantic" string. Texture, atmosphere, production character, emotional colour.
A word belongs in exactly one place. "Dub techno at 100 BPM, hazy and cavernous, emerging artists only" becomes bpm 94-106, tags ["dub techno"], emergence_max 20, and semantic "hazy, cavernous, heavily reverberant, deep and spacious, warm analogue haze".

MODES. The corpus is labelled with real modal analysis, not just major/minor:
  ionian (major), dorian, phrygian, lydian, mixolydian, aeolian (natural minor),
  locrian, harmonic_minor, phrygian_dominant, whole_tone.
  - A named mode maps directly and should set min_mode_confidence 0.5.
  - Vague "minor" -> ["aeolian","dorian","phrygian"]. Vague "major" -> ["ionian","lydian","mixolydian"].
  - Mode words in a query are ALWAYS hard constraints, never vibe.

OBSCURITY. emergence_max is a percentile ceiling where LOW MEANS OBSCURE. "emerging", "unknown", "underground", "no big names" -> 20. Leave null unless the user actually asked.

TEMPO. Only ever from an actual number. "around N BPM" -> N-6 to N+6. "roughly N" -> N-10 to N+10.
A named range is used literally. Genre names are NOT tempo constraints — do not infer BPM from
"techno" or "drum and bass". Bare speed words ("fast", "slow", "uptempo") are weak evidence: prefer
putting them in semantic, and only set a wide range if the user clearly means tempo specifically.

BRIGHTNESS IS A COMMON TRAP. It means spectral brightness, i.e. how much high-frequency content is present.
  - "dark", "murky", "muffled", "no top end", "dark on top", "rolled off" -> brightness_max (LOW ceiling, e.g. 0.4). NEVER brightness_min.
  - "bright", "crisp", "airy", "shimmering", "bright on top" -> brightness_min (e.g. 0.6).
  A phrase containing the word "top" is about brightness, and the direction is set by the adjective attached to it, not by the word "top".

Be conservative. A constraint you invent removes correct results permanently; a vibe word that ends up in "semantic" only reorders them. When in doubt, put it in semantic and leave the typed field null.

WORKED EXAMPLES.

"dub techno from emerging artists, around 100 BPM"
  bpm_min 94, bpm_max 106, emergence_max 20, tags ["dub techno"],
  semantic "deep chord stabs drenched in reverb, heavy sub bass, warm analogue hiss, hypnotic and spacious"
  (Note: even with no explicit vibe words, semantic describes the implied sound. It is never left blank.)

"uptempo electronica in Phrygian, no vocals, high energy"
  bpm_min 130, bpm_max 150, modes ["phrygian"], min_mode_confidence 0.5, instrumental true, energy_min 0.6,
  tags ["electronica"],
  semantic "driving synthetic rhythms, tense and propulsive, dark modal melody"

"hazy and cavernous, warm tape saturation, dark on top"
  brightness_max 0.4, everything else null,
  semantic "hazy, cavernous, enormous reverberant space, warm saturated tape, soft rolled-off high end"
  (Note: "dark on top" is brightness_max, NOT brightness_min.)

"lo-fi hip hop"
  EVERY typed field null. tags ["lo-fi","hip hop"],
  semantic "dusty sampled drums, warm vinyl crackle and tape hiss, mellow jazzy chords, unhurried head-nod groove"
  (Note: a bare genre name produces NO hard constraints at all. Not tempo, not energy, not brightness.
   The genre lives entirely in semantic, where it can rank without excluding anything.)

"sad piano music"
  EVERY typed field null. tags ["piano"],
  semantic "solo piano, slow and melancholy, sparse and intimate, soft sustained chords, reflective"
  (Note: "sad" is a mood, not a mode. Do not emit modes ["aeolian"] for it — the user did not name a mode.)`;

// ---------------------------------------------------------------------------
// re-ranker
// ---------------------------------------------------------------------------
export const RerankSchema = z.object({
  ranked: z.array(z.object({ id: z.string(), reason: z.string() })),
  summary: z.string(),
});
export type RerankResult = z.infer<typeof RerankSchema>;

export const RERANK_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ranked', 'summary'],
  properties: {
    ranked: {
      type: 'array',
      description: 'Candidates in your preferred order, best first. Include only the ones actually worth returning; dropping a poor match is better than padding the list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string', description: 'The candidate id exactly as given.' },
          reason: { type: 'string', description: 'One specific sentence on why THIS track answers THIS query, citing a measured feature. Never generic praise.' },
        },
      },
    },
    summary: { type: 'string', description: 'One sentence describing the shape of the result set, including anything the corpus could not satisfy.' },
  },
} as const;

export const RERANK_SYSTEM = `You are the final ranking stage of CRATE, a music search engine.

Every candidate you are given has ALREADY passed the user's hard constraints in SQL. You cannot and need not re-check tempo, key, mode, or vocals — they are guaranteed. Your job is to order the survivors by how well they answer the intent behind the query, and to say why.

Write reasons a producer would find useful. Cite the actual measured numbers you were given: "122 BPM with a 0.71 percussive ratio and almost no top end above 4 kHz" is useful. "A great atmospheric track" is not, and is the failure mode to avoid.

If a mode was detected with low confidence, or was reported as unclear, say so plainly in the reason rather than implying certainty the analysis does not have.

Drop candidates that genuinely do not fit. A short honest list beats a padded one.`;
