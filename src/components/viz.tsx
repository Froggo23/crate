'use client';

import { PITCH_NAMES } from '@/lib/llm/schema';

const MODE_DEGREES: Record<string, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian_dominant: [0, 1, 4, 5, 7, 8, 10],
  whole_tone: [0, 2, 4, 6, 8, 10],
};

/**
 * Harmonic pitch class profile as a wheel.
 *
 * Petal length is the energy on that pitch class; the ring marks which pitch
 * classes belong to the detected mode, and the tonic is filled. Reading it
 * against the ring is how you check the classifier's work by eye: a Phrygian
 * call should show a long petal one semitone clockwise of a filled tonic.
 */
export function HpcpWheel({
  hpcp, tonic, mode, size = 190, label,
}: {
  hpcp: number[] | null;
  tonic: number | null;
  mode: string | null;
  size?: number;
  label?: string;
}) {
  if (!hpcp || hpcp.length !== 12) {
    return <div className="text-mute text-xs" style={{ width: size }}>no profile</div>;
  }
  const cx = size / 2, cy = size / 2;
  const rInner = size * 0.17, rOuter = size * 0.40;
  const max = Math.max(...hpcp, 1e-6);
  const degrees = mode && MODE_DEGREES[mode] ? MODE_DEGREES[mode] : null;
  const inScale = (pc: number) =>
    degrees != null && tonic != null && degrees.includes(((pc - tonic) % 12 + 12) % 12);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
         aria-label={label ?? 'harmonic pitch class profile'}>
      <circle cx={cx} cy={cy} r={rOuter + 15} fill="none" stroke="var(--line)" strokeWidth="1" />
      {hpcp.map((v, pc) => {
        const a0 = (pc / 12) * Math.PI * 2 - Math.PI / 2;
        const a1 = ((pc + 0.82) / 12) * Math.PI * 2 - Math.PI / 2;
        const r = rInner + (rOuter - rInner) * (v / max);
        const p = (ang: number, rad: number) => `${cx + Math.cos(ang) * rad},${cy + Math.sin(ang) * rad}`;
        const isTonic = pc === tonic;
        const member = inScale(pc);
        const fill = isTonic ? 'var(--accent)' : member ? 'var(--cyan)' : 'var(--line-2)';
        const la = (a1 - a0) > Math.PI ? 1 : 0;
        const d = `M ${p(a0, rInner)} L ${p(a0, r)} A ${r} ${r} 0 ${la} 1 ${p(a1, r)} L ${p(a1, rInner)} A ${rInner} ${rInner} 0 ${la} 0 ${p(a0, rInner)} Z`;
        return <path key={pc} d={d} fill={fill} opacity={isTonic ? 0.95 : member ? 0.75 : 0.4} />;
      })}
      {hpcp.map((_, pc) => {
        const a = ((pc + 0.41) / 12) * Math.PI * 2 - Math.PI / 2;
        const r = rOuter + 8;
        const isTonic = pc === tonic;
        return (
          <text
            key={pc}
            x={cx + Math.cos(a) * r}
            y={cy + Math.sin(a) * r}
            textAnchor="middle" dominantBaseline="central"
            fontSize={size * 0.055}
            fontFamily="var(--font-mono)"
            fill={isTonic ? 'var(--accent)' : inScale(pc) ? 'var(--text-dim)' : 'var(--text-mute)'}
            fontWeight={isTonic ? 700 : 400}
          >
            {PITCH_NAMES[pc]}
          </text>
        );
      })}
    </svg>
  );
}

/** Confidence as a small segmented meter — reads faster than a number alone. */
export function ConfidenceMeter({ value, width = 54 }: { value: number | null; width?: number }) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  const segs = 6;
  const on = Math.round(v * segs);
  const colour = v >= 0.66 ? 'var(--green)' : v >= 0.34 ? 'var(--accent)' : 'var(--red)';
  return (
    <span className="inline-flex gap-[2px] items-center" style={{ width }} title={`confidence ${v.toFixed(2)}`}>
      {Array.from({ length: segs }, (_, i) => (
        <span key={i} className="h-[9px] flex-1 rounded-[1px]"
              style={{ background: i < on ? colour : 'var(--line-2)', opacity: i < on ? 1 : 0.5 }} />
      ))}
    </span>
  );
}

/** Ranked mode hypotheses, so the runner-up is visible rather than hidden. */
export function ModeHypotheses({ scores }: { scores: Record<string, unknown> | null }) {
  if (!scores) return null;
  const entries = Object.entries(scores)
    .filter(([k, v]) => typeof v === 'number' && !k.endsWith('_tonic') && k !== 'tonal_clarity')
    .map(([k, v]) => ({ mode: k, score: v as number }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (!entries.length) return null;
  const hi = entries[0].score;
  const lo = Math.min(...entries.map((e) => e.score));
  const span = Math.max(1e-6, hi - lo);

  return (
    <div className="space-y-1">
      {entries.map((e, i) => {
        const tonicPc = scores[`${e.mode}_tonic`];
        const name = typeof tonicPc === 'number' ? `${PITCH_NAMES[tonicPc]} ${e.mode.replace(/_/g, ' ')}` : e.mode.replace(/_/g, ' ');
        return (
          <div key={e.mode} className="flex items-center gap-2 text-[11px]">
            <span className={`w-32 shrink-0 truncate ${i === 0 ? 'text-accent' : 'text-dim'}`}>{name}</span>
            <span className="flex-1 h-[6px] rounded-full bg-surface-2 overflow-hidden">
              <span className="block h-full rounded-full"
                    style={{ width: `${8 + 92 * ((e.score - lo) / span)}%`, background: i === 0 ? 'var(--accent)' : 'var(--line-2)' }} />
            </span>
            <span className="num text-mute w-10 text-right">{e.score.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
}
