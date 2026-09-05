/**
 * Shared HTTP helpers: timeouts, retry with exponential backoff, and a token
 * bucket so we stay inside the published rate limits of the open APIs CRATE
 * depends on. MusicBrainz in particular will block a client that ignores its
 * 1 req/s guidance, and being blocked mid-crawl is the expensive failure.
 */

export const USER_AGENT =
  process.env.CRATE_USER_AGENT ??
  'CRATE/0.1 (+https://github.com/Froggo23/crate)';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** treat these statuses as terminal, do not retry */
  noRetryOn?: number[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url: string, opt: FetchOptions = {}): Promise<Response> {
  const retries = opt.retries ?? 4;
  const timeoutMs = opt.timeoutMs ?? 30_000;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        method: opt.method ?? 'GET',
        body: opt.body,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...opt.headers },
      });
      clearTimeout(timer);
      if (res.ok) return res;
      // surface the server's own explanation on terminal failures
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const detail = await res.text().catch(() => '');
        throw new HttpError(res.status, `${res.status} ${url} ${detail.slice(0, 300)}`);
      }
      if (opt.noRetryOn?.includes(res.status)) throw new HttpError(res.status, `${res.status} ${url}`);
      // 4xx other than 429 will not fix themselves
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new HttpError(res.status, `${res.status} ${url}`);
      }
      lastErr = new HttpError(res.status, `${res.status} ${url}`);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
    if (attempt < retries) await sleep(Math.min(20_000, 800 * 2 ** attempt) + Math.random() * 400);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = unknown>(url: string, opt: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, opt);
  return (await res.json()) as T;
}

/** Simple spacing limiter: guarantees at least `intervalMs` between calls. */
export class RateLimiter {
  private last = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private intervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const wait = this.intervalMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    this.queue = task.catch(() => {});
    return task.then(fn);
  }
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}
