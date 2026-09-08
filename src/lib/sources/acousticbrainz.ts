/**
 * Corpus source: the AcousticBrainz published dumps.
 *
 * The argument for this over analysing audio ourselves is simple: for ~7M
 * recordings the analysis has ALREADY BEEN DONE. AcousticBrainz ran Essentia
 * across user-submitted libraries and published the results, including the
 * harmonic pitch class profile this project's mode classifier consumes. Reusing
 * that costs one bounded download and no audio transfer at all.
 *
 * WHAT WE GAIN over the audio pipeline:
 *   - MusicBrainz IDs on every row, so artist identity and ListenBrainz listen
 *     counts resolve properly instead of by fuzzy name match
 *   - Essentia's OWN key output, so the baseline is the real extractor named in
 *     the plan rather than a reimplementation of it
 *   - `voice_instrumental`, a trained classifier, replacing the 3-8 Hz
 *     modulation heuristic that was the weakest number in the system
 *   - four independent genre taxonomies, which section 4.2 explicitly wants
 *     ("lets you compare taxonomies rather than trusting one")
 *
 * WHAT WE LOSE, measured rather than assumed:
 *   - Only AGGREGATE HPCP is published (mean/median/var over the whole track),
 *     never per-frame. Re-running key detection on the stored mean reproduces
 *     Essentia's own answer just 52% of the time, so roughly half the tonal
 *     information is gone before we start.
 *   - The bass-register, downbeat and phrase-final weighting cannot be
 *     reconstructed from an aggregate at all. `chords_histogram` substitutes a
 *     harmonic route to the tonic, but it is not the same evidence.
 *   - No audio to stream, so these rows link out rather than play.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AbRecord {
  mbid: string;
  artist: string;
  title: string;
  album: string | null;
  year: number | null;
  durationSec: number | null;

  hpcp36: number[];
  chordsHistogram: number[];
  chordsKey: string | null;
  chordsScale: string | null;
  essentiaKey: string | null;
  essentiaScale: string | null;
  keyStrength: number | null;
  hpcpEntropy: number | null;

  bpm: number | null;
  onsetRate: number | null;
  danceability: number | null;
  beatsCount: number | null;

  averageLoudness: number | null;
  spectralCentroid: number | null;
  dissonance: number | null;
  dynamicComplexity: number | null;
  zcr: number | null;
  mfcc: number[];

  /** from the high-level dump, when present */
  voiceInstrumental: number | null;   // 1 = instrumental, 0 = voice
  genres: string[];
  moods: string[];
  timbreBright: number | null;
  tonalAtonal: number | null;
}

const first = (v: unknown): string | null =>
  Array.isArray(v) ? (v[0] == null ? null : String(v[0])) : v == null ? null : String(v);

interface HlEntry { value?: string; probability?: number }

/** Walk `dir` recursively, yielding absolute paths of every .json file. */
export async function* walkJson(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJson(p);
    else if (e.name.endsWith('.json')) yield p;
  }
}

export async function parseRecord(
  lowPath: string,
  highRoot: string | null,
): Promise<AbRecord | null> {
  let low: Record<string, never>;
  try {
    low = JSON.parse(await readFile(lowPath, 'utf8'));
  } catch { return null; }

  const meta = (low as never as { metadata?: Record<string, never> }).metadata ?? {};
  const tags = (meta as { tags?: Record<string, unknown> }).tags ?? {};
  const props = (meta as { audio_properties?: Record<string, number> }).audio_properties ?? {};
  const tonal = (low as never as { tonal?: Record<string, never> }).tonal ?? {};
  const rhythm = (low as never as { rhythm?: Record<string, never> }).rhythm ?? {};
  const ll = (low as never as { lowlevel?: Record<string, never> }).lowlevel ?? {};

  const hpcp = (tonal as { hpcp?: { mean?: number[] } }).hpcp?.mean;
  if (!hpcp || hpcp.length !== 36) return null;

  const artist = first(tags.artist) ?? first(tags.albumartist);
  const title = first(tags.title);
  if (!artist || !title) return null;

  const mbid = first(tags.musicbrainz_recordingid)
    ?? lowPath.split('/').pop()!.replace(/-\d+\.json$/, '');

  const dateStr = first(tags.date) ?? '';
  const ym = dateStr.match(/(\d{4})/);
  const year = ym ? Number(ym[1]) : null;

  // --- high-level classifiers, if the companion dump is present -------------
  let hl: Record<string, HlEntry> = {};
  if (highRoot) {
    const base = lowPath.split('/lowlevel/')[1];
    if (base) {
      try {
        const raw = await readFile(join(highRoot, 'highlevel', base), 'utf8');
        hl = (JSON.parse(raw) as { highlevel?: Record<string, HlEntry> }).highlevel ?? {};
      } catch { /* a missing high-level record is not fatal */ }
    }
  }

  const prob = (k: string, positive: string): number | null => {
    const e = hl[k];
    if (!e?.value || e.probability == null) return null;
    return e.value === positive ? e.probability : 1 - e.probability;
  };

  const genres = Array.from(new Set([
    hl.genre_dortmund?.value, hl.genre_electronic?.value,
    hl.genre_rosamerica?.value, hl.genre_tzanetakis?.value,
    ...(first(tags.genre) ? [first(tags.genre)!.toLowerCase()] : []),
  ].filter(Boolean) as string[]));

  const moods = Object.entries(hl)
    .filter(([k, v]) => k.startsWith('mood_') && v.value && !v.value.startsWith('not_') && (v.probability ?? 0) > 0.6)
    .map(([, v]) => v.value!.replace(/^mood_/, ''));

  const num = (o: unknown, path: string): number | null => {
    const parts = path.split('.');
    let cur: unknown = o;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[p];
    }
    return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
  };

  return {
    mbid,
    artist: artist.slice(0, 200),
    title: title.slice(0, 300),
    album: first(tags.album)?.slice(0, 300) ?? null,
    year: year && year > 1900 && year < 2100 ? year : null,
    durationSec: num(props, 'length'),

    hpcp36: hpcp,
    chordsHistogram: (tonal as { chords_histogram?: number[] }).chords_histogram ?? [],
    chordsKey: (tonal as { chords_key?: string }).chords_key ?? null,
    chordsScale: (tonal as { chords_scale?: string }).chords_scale ?? null,
    essentiaKey: (tonal as { key_key?: string }).key_key ?? null,
    essentiaScale: (tonal as { key_scale?: string }).key_scale ?? null,
    keyStrength: num(tonal, 'key_strength'),
    hpcpEntropy: num(tonal, 'hpcp_entropy.mean'),

    bpm: num(rhythm, 'bpm'),
    onsetRate: num(rhythm, 'onset_rate'),
    danceability: num(rhythm, 'danceability'),
    beatsCount: num(rhythm, 'beats_count'),

    averageLoudness: num(ll, 'average_loudness'),
    spectralCentroid: num(ll, 'spectral_centroid.mean'),
    dissonance: num(ll, 'dissonance.mean'),
    dynamicComplexity: num(ll, 'dynamic_complexity'),
    zcr: num(ll, 'zerocrossingrate.mean'),
    mfcc: ((ll as { mfcc?: { mean?: number[] } }).mfcc?.mean ?? []).slice(0, 13),

    voiceInstrumental: prob('voice_instrumental', 'instrumental'),
    genres: genres.slice(0, 12),
    moods: moods.slice(0, 6),
    timbreBright: prob('timbre', 'bright'),
    tonalAtonal: prob('tonal_atonal', 'tonal'),
  };
}
