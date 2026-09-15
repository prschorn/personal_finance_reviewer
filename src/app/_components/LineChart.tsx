'use client';

import { useId, useMemo, useState } from 'react';
import type { Series } from '../../queries/dashboard';
import { formatBRL } from '../../lib/money';
import { seriesVar } from './chart-palette';

/**
 * A line chart for money over months.
 *
 * One y-axis, always — two measures of different scale would get two charts, not
 * a second axis. Marks are thin, the grid is a recessive hairline, and values are
 * direct-labelled only at the line ends, and only when few enough series that the
 * labels cannot collide. Everything else is carried by the crosshair tooltip and
 * the table view.
 */

const PAD = { top: 16, right: 20, bottom: 28, left: 56 };
const HEIGHT = 260;
/** Below this many series, end labels fit without colliding. */
const DIRECT_LABEL_MAX = 4;

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(v);
  return ticks;
}

function compact(cents: number): string {
  const reais = Math.abs(cents) / 100;
  if (reais >= 1000) return `${(reais / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return reais.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

export function LineChart({
  series,
  labels,
  caption,
}: {
  series: Series[];
  labels: string[];
  caption: string;
}) {
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visible = series.filter((s) => !hidden.has(s.name));

  const { width, xs, y, ticks } = useMemo(() => {
    const width = Math.max(420, 70 * labels.length + PAD.left + PAD.right);
    const peak = Math.max(1, ...visible.flatMap((s) => s.values.map((v) => Math.max(0, v))));
    const ticks = niceTicks(peak);
    const top = ticks[ticks.length - 1] ?? peak;
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const xs = labels.map((_, i) =>
      labels.length === 1 ? PAD.left + plotW / 2 : PAD.left + (i * plotW) / (labels.length - 1),
    );
    const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / top) * plotH;
    return { width, xs, y, ticks };
  }, [visible, labels]);

  if (!series.length) {
    return (
      <p className="py-8 text-[14px]" style={{ color: 'var(--ink-soft)' }}>
        Nada para mostrar neste período.
      </p>
    );
  }

  const path = (s: Series) =>
    s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs[i]!.toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const showEndLabels = visible.length > 0 && visible.length <= DIRECT_LABEL_MAX;

  /**
   * End labels, nudged apart when two lines finish close together.
   *
   * Two labels drawn at their true y overlap into an unreadable smudge; stacking
   * them in a block would lose which line each belongs to. Pushing each down to
   * clear the one above keeps them beside their own line and legible.
   */
  const endLabels = (() => {
    const i = labels.length - 1;
    const placed = visible
      .map((s) => ({ name: s.name, text: compact(s.values[i] ?? 0), y: y(s.values[i] ?? 0) - 10, x: (xs[i] ?? 0) - 8 }))
      .sort((a, b) => a.y - b.y);
    const MIN_GAP = 13;
    for (let k = 1; k < placed.length; k++) {
      const prev = placed[k - 1]!;
      const cur = placed[k]!;
      if (cur.y - prev.y < MIN_GAP) cur.y = prev.y + MIN_GAP;
    }
    return placed;
  })();

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={caption}
          className="max-w-full"
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={0} width={width - PAD.left - PAD.right} height={HEIGHT} />
            </clipPath>
          </defs>

          {/* Recessive grid: solid hairlines one shade off the surface, never dashed. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
                stroke="var(--rule)" strokeWidth={1}
              />
              <text
                x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end"
                className="tnum" fontSize={11} fill="var(--ink-faint)"
              >
                {compact(t)}
              </text>
            </g>
          ))}

          {labels.map((label, i) => (
            <text
              key={label} x={xs[i]} y={HEIGHT - 8} textAnchor="middle"
              fontSize={11} fill={hover === i ? 'var(--ink)' : 'var(--ink-faint)'}
            >
              {label}
            </text>
          ))}

          {hover !== null && (
            <line
              x1={xs[hover]} x2={xs[hover]} y1={PAD.top} y2={HEIGHT - PAD.bottom}
              stroke="var(--rule-strong)" strokeWidth={1}
            />
          )}

          <g clipPath={`url(#${clipId})`}>
            {visible.map((s) => (
              <path
                key={s.name} d={path(s)} fill="none" stroke={seriesVar(s.slot)}
                strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              />
            ))}
          </g>

          {/* Markers only where they say something: the hovered month and each line end. */}
          {visible.map((s) => {
            const last = s.values.length - 1;
            const points = hover === null ? [last] : [...new Set([last, hover])];
            return points.map((i) => (
              <circle
                key={`${s.name}-${i}`} cx={xs[i]} cy={y(s.values[i] ?? 0)} r={4}
                fill={seriesVar(s.slot)} stroke="var(--paper)" strokeWidth={2}
              />
            ));
          })}

          {showEndLabels &&
            endLabels.map((l) => (
              <text
                key={`lbl-${l.name}`} x={l.x} y={l.y}
                textAnchor="end" fontSize={11} fill="var(--ink-soft)" className="tnum"
              >
                {l.text}
              </text>
            ))}

          {/* Hit targets wider than the marks. */}
          {labels.map((label, i) => (
            <rect
              key={`hit-${label}`}
              x={(xs[i] ?? 0) - (width - PAD.left - PAD.right) / (2 * Math.max(1, labels.length - 1))}
              y={0}
              width={(width - PAD.left - PAD.right) / Math.max(1, labels.length - 1)}
              height={HEIGHT}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
      </div>

      {hover !== null && (
        <div
          role="status"
          className="mt-2 rounded border px-3 py-2 text-[12px]"
          style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
        >
          <span className="font-medium">{labels[hover]}</span>
          <span className="ml-3 inline-flex flex-wrap gap-x-4 gap-y-1">
            {visible.map((s) => (
              <span key={s.name} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: seriesVar(s.slot) }}
                />
                {/* Text wears text tokens; the swatch carries identity. */}
                <span style={{ color: 'var(--ink-soft)' }}>{s.name}</span>
                <span className="tnum">{formatBRL(s.values[hover] ?? 0)}</span>
              </span>
            ))}
          </span>
        </div>
      )}

      {/* A legend is always present for two or more series. Clicking one hides it. */}
      {series.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[12px]">
          {series.map((s) => {
            const off = hidden.has(s.name);
            return (
              <button
                key={s.name}
                type="button"
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    next.has(s.name) ? next.delete(s.name) : next.add(s.name);
                    return next;
                  })
                }
                className="inline-flex items-center gap-1.5"
                style={{ opacity: off ? 0.4 : 1 }}
                aria-pressed={!off}
              >
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: seriesVar(s.slot) }}
                />
                <span style={{ color: 'var(--ink-soft)' }}>{s.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </figure>
  );
}
