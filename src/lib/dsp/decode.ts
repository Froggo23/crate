/**
 * Audio ingest. ffmpeg does the container/codec work and HTTP range requests;
 * everything downstream is ours.
 *
 * We analyse a 60 s excerpt taken from 25% into the track rather than the whole
 * file, for three reasons: intros are frequently unrepresentative (silence,
 * field recordings, a single held pad), full-file analysis over a corpus is
 * bandwidth-bound rather than CPU-bound, and ffmpeg's `-ss` before `-i` turns
 * into a byte-range request, so we transfer ~1-2 MB instead of ~40 MB per track.
 *
 * The excerpt policy is a real limitation and is reported as such: a track whose
 * mode changes at the bridge will be labelled from its first section only.
 */

import { spawn } from 'node:child_process';

export const SAMPLE_RATE = 22050;
export const EXCERPT_SECONDS = 60;
export const EXCERPT_START_FRACTION = 0.25;

export interface DecodeOptions {
  offsetSec?: number;
  durationSec?: number;
  sampleRate?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export class DecodeError extends Error {}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { p.kill('SIGKILL'); reject(new DecodeError(`${cmd} timed out after ${timeoutMs}ms`)); }
    }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString(); });
    p.on('error', (e) => { done = true; clearTimeout(timer); reject(new DecodeError(`${cmd}: ${e.message}`)); });
    p.on('close', (code) => {
      done = true; clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err, code });
    });
  });
}

export async function probeDuration(url: string, userAgent: string, timeoutMs = 25_000): Promise<number | null> {
  try {
    const { stdout, code } = await run('ffprobe', [
      '-v', 'error',
      '-user_agent', userAgent,
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      url,
    ], timeoutMs);
    if (code !== 0) return null;
    const d = parseFloat(stdout.toString().trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** Decode to mono float32 PCM at `sampleRate`, returned as Float64Array. */
export async function decodeAudio(url: string, opt: DecodeOptions = {}): Promise<Float64Array> {
  const sr = opt.sampleRate ?? SAMPLE_RATE;
  const dur = opt.durationSec ?? EXCERPT_SECONDS;
  const off = Math.max(0, opt.offsetSec ?? 0);
  const ua = opt.userAgent ?? 'CRATE/0.1';

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', ua,
    '-err_detect', 'ignore_err',
  ];
  if (off > 0) args.push('-ss', off.toFixed(2));
  args.push(
    '-i', url,
    '-t', dur.toFixed(2),
    '-vn', '-sn', '-dn',
    '-ac', '1',
    '-ar', String(sr),
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    'pipe:1',
  );

  const { stdout, stderr, code } = await run('ffmpeg', args, opt.timeoutMs ?? 90_000);
  if (code !== 0 && stdout.length === 0) {
    throw new DecodeError(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`);
  }
  const n = Math.floor(stdout.length / 4);
  if (n < sr * 5) {
    throw new DecodeError(`decoded only ${(n / sr).toFixed(1)}s of audio (need >= 5s)`);
  }
  const view = new DataView(stdout.buffer, stdout.byteOffset, n * 4);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = view.getFloat32(i * 4, true);
  return x;
}

/** Choose where to start the excerpt given a known (or unknown) track length. */
export function excerptOffset(totalSec: number | null): number {
  if (!totalSec || totalSec <= EXCERPT_SECONDS * 1.5) return 0;
  return Math.min(totalSec * EXCERPT_START_FRACTION, Math.max(0, totalSec - EXCERPT_SECONDS - 5));
}
