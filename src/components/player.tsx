'use client';

import { useSyncExternalStore, useCallback } from 'react';

/**
 * One audio element for the whole app.
 *
 * Result lists mount and unmount constantly; giving each row its own <audio>
 * means several tracks can play at once and playback dies on re-render. A single
 * module-level element with a tiny external store keeps playback stable across
 * navigation and makes "only one thing plays at a time" structural.
 */

export interface PlayerState {
  trackId: string | null;
  src: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  loading: boolean;
  error: string | null;
}

let state: PlayerState = {
  trackId: null, src: null, playing: false,
  currentTime: 0, duration: 0, loading: false, error: null,
};

const listeners = new Set<() => void>();
let el: HTMLAudioElement | null = null;
let startedAt = 0;

/** callback invoked the first time a track is played, for feedback logging */
let onFirstPlay: ((trackId: string) => void) | null = null;
export function setOnFirstPlay(fn: ((trackId: string) => void) | null) { onFirstPlay = fn; }

function emit(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function audio(): HTMLAudioElement {
  if (el) return el;
  el = new Audio();
  el.preload = 'none';
  el.crossOrigin = 'anonymous';
  el.addEventListener('play', () => emit({ playing: true, loading: false }));
  el.addEventListener('pause', () => emit({ playing: false }));
  el.addEventListener('waiting', () => emit({ loading: true }));
  el.addEventListener('playing', () => emit({ loading: false, error: null }));
  el.addEventListener('timeupdate', () => emit({ currentTime: el!.currentTime }));
  el.addEventListener('durationchange', () => emit({ duration: Number.isFinite(el!.duration) ? el!.duration : 0 }));
  el.addEventListener('ended', () => emit({ playing: false, currentTime: 0 }));
  el.addEventListener('error', () => emit({ playing: false, loading: false, error: 'could not stream this file' }));
  return el;
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const getSnapshot = () => state;
const SERVER_SNAPSHOT: PlayerState = {
  trackId: null, src: null, playing: false, currentTime: 0, duration: 0, loading: false, error: null,
};

export function usePlayer() {
  const s = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);

  const toggle = useCallback((trackId: string, src: string) => {
    const a = audio();
    if (state.trackId === trackId) {
      if (a.paused) { void a.play().catch(() => emit({ error: 'playback blocked' })); }
      else a.pause();
      return;
    }
    a.pause();
    a.src = src;
    emit({ trackId, src, playing: false, currentTime: 0, duration: 0, loading: true, error: null });
    startedAt = Date.now();
    onFirstPlay?.(trackId);
    void a.play().catch(() => emit({ loading: false, error: 'playback blocked by the browser' }));
  }, []);

  const seek = useCallback((t: number) => {
    const a = audio();
    if (Number.isFinite(a.duration)) { a.currentTime = Math.max(0, Math.min(a.duration, t)); }
  }, []);

  const stop = useCallback(() => { audio().pause(); emit({ playing: false }); }, []);

  return { ...s, toggle, seek, stop, dwellMs: () => Date.now() - startedAt };
}

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
