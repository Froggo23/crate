/**
 * Corpus source: the Internet Archive's `netlabels` collection.
 *
 * 77,000 audio items released by net labels under Creative Commons licences.
 * This is a deliberate substitution for the project plan's MTG-Jamendo corpus,
 * for one practical reason and one that turns out to matter more:
 *
 *   - practical: MTG-Jamendo's audio is a 46 GB download for the mood subset.
 *     The netlabels collection is streamable per-track over HTTP range requests,
 *     so a corpus can be built incrementally and resumed after a failure.
 *   - substantive: it is the same POPULATION. Net label releases are exactly the
 *     independent, low-listener-count electronic music that section 2.2 is built
 *     to surface, and the licences permit hosting a playable demo -- which the
 *     plan is explicit about ("a recommender you cannot play is not a demo").
 */

import { fetchJson, USER_AGENT } from '../net';

const SCRAPE = 'https://archive.org/services/search/v1/scrape';
const METADATA = 'https://archive.org/metadata';
export const DOWNLOAD = 'https://archive.org/download';

export interface ScrapeItem {
  identifier: string;
  title?: string;
  creator?: string | string[];
  year?: number;
  subject?: string | string[];
  licenseurl?: string;
  downloads?: number;
}

interface ScrapeResponse {
  items: ScrapeItem[];
  count: number;
  total: number;
  cursor?: string;
}

/** One page of the collection. `cursor` is opaque; pass it back to continue. */
export async function scrapePage(
  cursor: string | null,
  count = 500,
  query = 'collection:netlabels AND mediatype:audio',
): Promise<{ items: ScrapeItem[]; cursor: string | null; total: number }> {
  const params = new URLSearchParams({
    q: query,
    fields: 'identifier,title,creator,year,date,subject,licenseurl,downloads',
    count: String(Math.max(100, count)),
  });
  if (cursor) params.set('cursor', cursor);
  const r = await fetchJson<ScrapeResponse>(`${SCRAPE}?${params}`, { timeoutMs: 60_000 });
  return { items: r.items ?? [], cursor: r.cursor ?? null, total: r.total ?? 0 };
}

interface ArchiveFile {
  name: string;
  format?: string;
  length?: string;      // "MM:SS" or seconds, inconsistently
  size?: string;
  title?: string;
  artist?: string;
  creator?: string;
  album?: string;
  track?: string;
}

interface ArchiveMetadata {
  metadata?: Record<string, unknown>;
  files?: ArchiveFile[];
}

/** archive.org reports durations as either "245.5" or "4:05" or "1:04:05". */
export function parseLength(v: string | undefined): number | null {
  if (!v) return null;
  if (v.includes(':')) {
    const parts = v.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const AUDIO_FORMATS = new Set([
  'VBR MP3', 'MP3', '128Kbps MP3', '256Kbps MP3', '320Kbps MP3', '64Kbps MP3', '96Kbps MP3',
]);

export interface TrackCandidate {
  sourceKey: string;
  identifier: string;
  fileName: string;
  title: string;
  artistName: string;
  album: string | null;
  year: number | null;
  durationSec: number | null;
  audioUrl: string;
  pageUrl: string;
  licenseUrl: string | null;
  licenseShort: string | null;
  artworkUrl: string | null;
  tags: string[];
  downloads: number | null;
}

const asArray = (v: string | string[] | undefined): string[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

/** "http://creativecommons.org/licenses/by-nc-sa/3.0/" -> "CC BY-NC-SA 3.0" */
export function shortLicense(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/licenses\/([a-z-]+)\/([\d.]+)/i);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  if (/publicdomain|zero/i.test(url)) return 'CC0 / Public Domain';
  return null;
}

/** Duration bounds: skip DJ mixes, radio shows and sub-minute interstitials. */
export const MIN_DURATION = 60;
export const MAX_DURATION = 900;

export async function itemTracks(
  item: ScrapeItem,
  maxPerItem = 3,
): Promise<TrackCandidate[]> {
  const meta = await fetchJson<ArchiveMetadata>(`${METADATA}/${encodeURIComponent(item.identifier)}`, {
    timeoutMs: 45_000,
    headers: { 'User-Agent': USER_AGENT },
  });
  const files = meta.files ?? [];
  const m = (meta.metadata ?? {}) as Record<string, unknown>;

  const artwork = files.find((f) => /\.(jpg|jpeg|png)$/i.test(f.name) && !/_thumb/i.test(f.name));
  const collectionTags = asArray(item.subject).flatMap((s) =>
    String(s).split(/[;,]/).map((x) => x.trim().toLowerCase()).filter((x) => x && x.length < 40));

  const itemArtist =
    asArray(item.creator)[0] ??
    (typeof m.creator === 'string' ? m.creator : Array.isArray(m.creator) ? String(m.creator[0]) : null);

  const year = item.year ?? (() => {
    const d = typeof m.date === 'string' ? m.date : '';
    const y = d.match(/(\d{4})/);
    const n = y ? Number(y[1]) : NaN;
    return Number.isFinite(n) && n > 1900 && n < 2100 ? n : null;
  })();

  const out: TrackCandidate[] = [];
  const seenTitles = new Set<string>();

  for (const f of files) {
    if (out.length >= maxPerItem) break;
    if (!f.format || !AUDIO_FORMATS.has(f.format)) continue;
    const dur = parseLength(f.length);
    if (dur == null || dur < MIN_DURATION || dur > MAX_DURATION) continue;

    const title = (f.title ?? f.name.replace(/\.[^.]+$/, '').replace(/^[\d\-_ .]+/, '')).trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;   // archive.org lists several encodings of the same track
    seenTitles.add(key);

    const artistName = (f.artist ?? f.creator ?? itemArtist ?? 'Unknown Artist').toString().trim();
    const licenseUrl = item.licenseurl ?? (typeof m.licenseurl === 'string' ? m.licenseurl : null);

    out.push({
      sourceKey: `archive:${item.identifier}:${f.name}`,
      identifier: item.identifier,
      fileName: f.name,
      title: title.slice(0, 300),
      artistName: artistName.slice(0, 200),
      album: (f.album ?? (typeof m.title === 'string' ? m.title : null))?.toString().slice(0, 300) ?? null,
      year,
      durationSec: dur,
      audioUrl: `${DOWNLOAD}/${encodeURIComponent(item.identifier)}/${encodeURIComponent(f.name)}`,
      pageUrl: `https://archive.org/details/${encodeURIComponent(item.identifier)}`,
      licenseUrl,
      licenseShort: shortLicense(licenseUrl),
      artworkUrl: artwork
        ? `${DOWNLOAD}/${encodeURIComponent(item.identifier)}/${encodeURIComponent(artwork.name)}`
        : null,
      tags: Array.from(new Set(collectionTags)).slice(0, 25),
      downloads: item.downloads ?? null,
    });
  }
  return out;
}
