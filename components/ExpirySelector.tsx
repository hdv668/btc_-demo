'use client';

import type { SliceStats } from '@/types';
import { useMemo } from 'react';

interface Props {
  stats: Record<string, SliceStats>;
  selectedExpiry: string;
  onSelect: (expiry: string) => void;
}

export default function ExpirySelector({ stats, selectedExpiry, onSelect }: Props) {
  const expiries = useMemo(
    () => Object.keys(stats).sort(),
    [stats]
  );

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
      {expiries.map(exp => {
        const s = stats[exp];
        const selected = exp === selectedExpiry;
        const daysLeft = Math.round(s.tte * 365);

        return (
          <button
            key={exp}
            onClick={() => onSelect(exp)}
            className={`flex-shrink-0 rounded-xl px-3 py-2 text-xs transition-all border
              ${selected
                ? 'bg-blue-600/30 border-blue-500/60 text-white'
                : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:border-slate-500'
              }`}
          >
            <div className="font-medium">{exp}</div>
            <div className="text-slate-500 mt-0.5">{daysLeft}d</div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-sky-400">{(s.atmVol * 100).toFixed(0)}%</span>
              <span className="text-slate-600">|</span>
              <span className={s.skew > 0 ? 'text-purple-400' : 'text-orange-400'}>
                sk {s.skew > 0 ? '+' : ''}{(s.skew * 100).toFixed(1)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
