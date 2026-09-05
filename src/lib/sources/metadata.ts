/**
 * Identity and popularity, from open sources only.
 *
 * Nothing musical comes from here. Tempo, key, mode and timbre are all measured
 * from audio by this repository's own DSP. These services answer a different
 * question -- "who is this artist, and how many people have heard them" -- which
 * is what the emergence score in section 2.2 needs and which cannot be derived
 * from a waveform.
 */

import { fetchJson, RateLimiter } from '../net';

/** MusicBrainz asks for at most one request per second and enforces it. */
export const mbLimiter = new RateLimiter(1100);
export const dzLimiter = new RateLimiter(220);

const norm = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

export interface MbArtist {
  mbid: string;
  name: string;
  country: string | null;
  type: string | null;
  beginYear: number | null;
  score: number;
}

interface MbResponse {
  artists?: {
    id: string; name: string; country?: string; type?: string;
    score?: number; 'life-span'?: { begin?: string };
  }[];
}

/**
 * Resolve an artist name to a MusicBrainz ID.
 *
 * The name check is strict on purpose. A fuzzy match here would attribute a
 * famous artist's listen count to an obscure one with a similar name, and the
 * emergence score -- the entire point of section 2.2 -- would quietly invert.
 * Better to leave an artist unresolved than to mislabel them as popular.
 */
export async function lookupMusicBrainz(name: string): Promise<MbArtist | null> {
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`);
  const url = `https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=3`;
  const r = await mbLimiter.run(() => fetchJson<MbResponse>(url, { timeoutMs: 25_000, retries: 2 }));
  const target = norm(name);
  for (const a of r.artists ?? []) {
    if ((a.score ?? 0) < 90) continue;
    if (norm(a.name) !== target) continue;
    const begin = a['life-span']?.begin;
    const year = begin ? Number(begin.slice(0, 4)) : NaN;
    return {
      mbid: a.id, name: a.name,
      country: a.country ?? null, type: a.type ?? null,
      beginYear: Number.isFinite(year) ? year : null,
      score: a.score ?? 0,
    };
  }
  return null;
}

export interface LbPopularity { mbid: string; listens: number; listeners: number }

/** ListenBrainz open listen counts — the primary emergence input. */
export async function listenBrainzPopularity(mbids: string[]): Promise<LbPopularity[]> {
  if (!mbids.length) return [];
  const out: LbPopularity[] = [];
  for (let i = 0; i < mbids.length; i += 50) {
    const chunk = mbids.slice(i, i + 50);
    try {
      const r = await fetchJson<{ artist_mbid: string; total_listen_count: number | null; total_user_count: number | null }[]>(
        'https://api.listenbrainz.org/1/popularity/artist',
        {
          method: 'POST', timeoutMs: 30_000, retries: 2,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artist_mbids: chunk }),
        },
      );
      for (const x of r) {
        out.push({ mbid: x.artist_mbid, listens: x.total_listen_count ?? 0, listeners: x.total_user_count ?? 0 });
      }
    } catch (e) {
      console.error('[listenbrainz] batch failed:', (e as Error).message);
    }
  }
  return out;
}

export interface DzArtist { id: number; fans: number; albums: number }

/** Deezer needs no key and gives a second, independent popularity signal. */
export async function lookupDeezer(name: string): Promise<DzArtist | null> {
  const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=3`;
  try {
    const r = await dzLimiter.run(() =>
      fetchJson<{ data?: { id: number; name: string; nb_fan?: number; nb_album?: number }[] }>(url, { timeoutMs: 20_000, retries: 2 }));
    const target = norm(name);
    for (const a of r.data ?? []) {
      if (norm(a.name) !== target) continue;   // same strictness as MusicBrainz
      return { id: a.id, fans: a.nb_fan ?? 0, albums: a.nb_album ?? 0 };
    }
  } catch { /* Deezer is a bonus signal; never fail enrichment over it */ }
  return null;
}
