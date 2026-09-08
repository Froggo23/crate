/**
 * The "audio card": a natural-language description generated from the measured
 * features, which is what actually gets embedded.
 *
 * WHY THIS EXISTS, stated plainly because it is the biggest deviation from the
 * project plan. The plan calls for LAION-CLAP, a joint text-audio embedding.
 * CLAP needs ~2 GB of weights and a torch runtime; it cannot run in a Vercel
 * function, and a retrieval path that only works on a workstation is not a
 * deployed system. So the text tower is approached from the other side: instead
 * of projecting audio into a shared text-audio space, the audio is DESCRIBED in
 * words grounded in measured DSP values, and that description is embedded in an
 * ordinary text space alongside the user's query.
 *
 * What this buys: it runs anywhere, it is fully inspectable (every card is
 * stored and shown in the UI), and the adjectives are traceable to numbers.
 * What it costs: it can only express distinctions the vocabulary below encodes.
 * A real CLAP vector captures texture this cannot name. That is why the schema
 * reserves `clap_vec vector(512)` and `scripts/clap_embed.py` ships alongside —
 * the swap is a backfill, not a rewrite.
 */

import type { AnalysisResult } from './dsp/analyze';

const band = <T,>(x: number, cuts: number[], vals: T[]): T => {
  for (let i = 0; i < cuts.length; i++) if (x < cuts[i]) return vals[i];
  return vals[vals.length - 1];
};

export const MODE_COLOUR: Record<string, string> = {
  ionian: 'bright, resolved, major-key',
  dorian: 'bittersweet minor with a lifted sixth, jazzy and cool',
  phrygian: 'dark and Spanish-tinged, flat-second tension',
  lydian: 'floating, dreamlike, unresolved and open',
  mixolydian: 'bluesy major with an unresolved flat seventh',
  aeolian: 'melancholic natural minor',
  locrian: 'unstable, groundless, no perfect fifth',
  harmonic_minor: 'dramatic minor with an eastern leading tone',
  phrygian_dominant: 'middle-eastern hijaz colour, exotic and tense',
  whole_tone: 'symmetrical and weightless, no tonal gravity',
  unclear: 'tonally ambiguous, no clear centre',
};

export function tempoWord(bpm: number): string {
  return band(bpm,
    [60, 76, 96, 110, 128, 140, 160],
    ['very slow and static', 'slow and spacious', 'downtempo', 'mid-tempo',
     'steady four-four club tempo', 'uptempo', 'fast and driving', 'very fast']);
}

export interface CardInput {
  title: string;
  artist: string;
  album?: string | null;
  year?: number | null;
  tags?: string[];
  analysis: AnalysisResult | Pick<AnalysisResult,
    'tempo' | 'mode' | 'spectral' | 'dynamics' | 'energy' | 'brightness' | 'instrumentalLikelihood'>;
}

export function buildCard(inp: CardInput): string {
  const a = inp.analysis;
  const s = a.spectral;
  const d = a.dynamics;

  const brightness = band(a.brightness, [0.25, 0.42, 0.58, 0.75],
    ['dark and muffled, almost no top end', 'warm and rounded, gentle highs',
     'balanced across the spectrum', 'bright and open', 'brilliant, airy, hissy top end']);

  const energy = band(a.energy, [0.2, 0.38, 0.55, 0.72],
    ['still, ambient, almost motionless', 'calm and restrained', 'moderate energy',
     'energetic and propulsive', 'intense, hard-hitting, maximal']);

  const texture = band(s.percussiveRatio, [0.32, 0.45, 0.58, 0.70],
    ['sustained and pad-like, almost no percussion', 'mostly harmonic with light rhythm',
     'balanced between sustained tone and percussion', 'percussive and rhythm-forward',
     'drum-dominated, sharp transients']);

  const grain = band(s.spectralFlatness, [0.02, 0.06, 0.12, 0.22],
    ['clean and tonal', 'mostly tonal with some grit', 'textured, some noise content',
     'noisy and grainy, tape-like', 'very noisy, hiss and static forward']);

  const lowEnd = band(s.lfRatio, [0.15, 0.35, 0.55, 0.72],
    ['thin low end', 'light bass', 'solid bass presence', 'heavy, weighty low end',
     'dominated by deep sub bass']);

  const dyn = band(d.dynamicRangeDb, [6, 12, 20, 30],
    ['heavily compressed and flat, loudness-war mastering', 'compressed and consistent',
     'moderate dynamic range', 'dynamic and breathing', 'very wide dynamics, quiet passages and peaks']);

  const space = band(d.crestFactor, [3, 6, 10, 16],
    ['dense and squashed', 'controlled transients', 'natural transient detail',
     'punchy with sharp peaks', 'extremely peaky and transient-heavy']);

  const voice = a.instrumentalLikelihood >= 0.6
    ? 'instrumental, no discernible vocal'
    : a.instrumentalLikelihood <= 0.45
      ? 'appears to contain vocals'
      : 'vocal presence uncertain';

  const modeName = a.mode.mode;
  const colour = MODE_COLOUR[modeName] ?? '';
  const tonal = modeName === 'unclear'
    ? `Tonally ambiguous — no mode could be assigned with confidence (${a.mode.tonalClarity.toFixed(2)} tonal clarity).`
    : `In ${a.mode.keyName}: ${colour}.`;

  const tags = (inp.tags ?? []).filter(Boolean).slice(0, 12);

  return [
    `"${inp.title}" by ${inp.artist}${inp.year ? ` (${inp.year})` : ''}${inp.album ? `, from ${inp.album}` : ''}.`,
    tags.length ? `Described by its release as: ${tags.join(', ')}.` : '',
    `${tempoWord(a.tempo.bpm)} at ${a.tempo.bpm.toFixed(0)} BPM.`,
    tonal,
    `Sound: ${brightness}; ${energy}; ${texture}; ${grain}; ${lowEnd}; ${dyn}; ${space}.`,
    `${voice}.`,
    `Spectral centroid ${s.spectralCentroid.toFixed(0)} Hz, rolloff ${s.spectralRolloff.toFixed(0)} Hz, ` +
    `loudness ${d.loudnessDb.toFixed(1)} dB, onset rate ${a.tempo.onsetRate.toFixed(1)}/s.`,
  ].filter(Boolean).join(' ');
}


// ---------------------------------------------------------------------------
// AcousticBrainz cards
// ---------------------------------------------------------------------------

/**
 * Card builder for AcousticBrainz-sourced tracks.
 *
 * Deliberately NOT reusing buildCard(). That function describes spectral
 * flatness, low-end ratio, crest factor and percussive ratio -- none of which
 * AcousticBrainz publishes. Passing defaults for them would emit confident
 * adjectives ("clean and tonal", "heavy low end") that describe nothing that was
 * measured, and those adjectives go straight into the embedding that retrieval
 * ranks on. A card must only claim what its source actually contains.
 *
 * In exchange this source has things the audio pipeline does not: four genre
 * taxonomies, seven mood classifiers, and a trained voice/instrumental model.
 */
export interface AbCardInput {
  title: string;
  artist: string;
  album?: string | null;
  year?: number | null;
  bpm: number | null;
  keyName: string;
  modeName: string;
  tonalClarity: number;
  genres: string[];
  moods: string[];
  instrumental: number | null;
  brightness: number | null;
  energy: number | null;
  danceability: number | null;
  dissonance: number | null;
  dynamicComplexity: number | null;
  spectralCentroid: number | null;
  tonalAtonal: number | null;
}

export function buildAbCard(i: AbCardInput): string {
  const band = <T,>(x: number | null, cuts: number[], vals: T[], fallback: T): T => {
    if (x == null) return fallback;
    for (let k = 0; k < cuts.length; k++) if (x < cuts[k]) return vals[k];
    return vals[vals.length - 1];
  };

  const brightness = band(i.brightness, [0.25, 0.42, 0.58, 0.75],
    ['dark and muffled, almost no top end', 'warm and rounded, gentle highs',
     'balanced across the spectrum', 'bright and open', 'brilliant, airy, hissy top end'],
    'unremarkable spectral balance');

  const energy = band(i.energy, [0.2, 0.38, 0.55, 0.72],
    ['still, ambient, almost motionless', 'calm and restrained', 'moderate energy',
     'energetic and propulsive', 'intense, hard-hitting, maximal'], 'moderate energy');

  const dance = band(i.danceability, [0.6, 1.2, 1.8],
    ['not danceable, no steady groove', 'a loose sense of pulse',
     'a solid danceable groove', 'strongly danceable, locked rhythm'], '');

  const rough = band(i.dissonance, [0.42, 0.46, 0.49],
    ['consonant and smooth', 'mostly consonant', 'somewhat dissonant',
     'harsh and dissonant'], '');

  const dyn = band(i.dynamicComplexity, [1.5, 3, 6],
    ['heavily compressed and flat', 'fairly consistent in level',
     'moderate dynamic movement', 'wide, breathing dynamics'], '');

  const voice = i.instrumental == null
    ? 'vocal presence unknown'
    : i.instrumental >= 0.6 ? 'instrumental, no discernible vocal'
    : i.instrumental <= 0.4 ? 'has vocals'
    : 'vocal presence uncertain';

  const tonal = i.modeName === 'unclear'
    ? `Tonally ambiguous — no mode could be assigned with confidence (${i.tonalClarity.toFixed(2)} tonal clarity).`
    : `In ${i.keyName}: ${MODE_COLOUR[i.modeName] ?? ''}.`;

  return [
    `"${i.title}" by ${i.artist}${i.year ? ` (${i.year})` : ''}${i.album ? `, from ${i.album}` : ''}.`,
    i.genres.length ? `Classified as: ${i.genres.join(', ')}.` : '',
    i.moods.length ? `Mood: ${i.moods.join(', ')}.` : '',
    i.bpm ? `${tempoWord(i.bpm)} at ${i.bpm.toFixed(0)} BPM.` : '',
    tonal,
    `Sound: ${[brightness, energy, dance, rough, dyn].filter(Boolean).join('; ')}.`,
    `${voice}.`,
    i.spectralCentroid ? `Spectral centroid ${i.spectralCentroid.toFixed(0)} Hz.` : '',
    i.tonalAtonal != null && i.tonalAtonal < 0.4 ? 'Classified as atonal.' : '',
  ].filter(Boolean).join(' ');
}
