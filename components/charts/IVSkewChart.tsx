'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import type { IVSurfacePoint } from '@/types';

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

interface Props {
  points: IVSurfacePoint[];
  expiry: string;
  symbol: string;
}

export default function IVSkewChart({ points, expiry, symbol }: Props) {
  const data = useMemo(() => {
    const slice = points.filter(p => p.expiry === expiry).sort((a, b) => a.moneyness - b.moneyness);

    const mktX: number[] = [], mktY: number[] = [];
    const fitX: number[] = [], fitY: number[] = [];
    const bumpX: number[] = [], bumpY: number[] = [], bumpT: string[] = [];
    const dipX: number[] = [], dipY: number[] = [], dipT: string[] = [];

    for (const p of slice) {
      mktX.push(p.moneyness); mktY.push(p.impliedVol * 100);
      if (p.fittedVol) { fitX.push(p.moneyness); fitY.push(p.fittedVol * 100); }
      if (!p.zScore) continue;
      const label = `K=${p.strike} IV=${(p.impliedVol * 100).toFixed(1)}% Fit=${((p.fittedVol ?? 0) * 100).toFixed(1)}% z=${p.zScore.toFixed(2)}`;
      if (p.anomalyType === 'bump') { bumpX.push(p.moneyness); bumpY.push(p.impliedVol * 100); bumpT.push(label + '【凸起·做空vol】'); }
      if (p.anomalyType === 'dip') { dipX.push(p.moneyness); dipY.push(p.impliedVol * 100); dipT.push(label + '【凹陷·做多vol】'); }
    }
    return { mktX, mktY, fitX, fitY, bumpX, bumpY, bumpT, dipX, dipY, dipT };
  }, [points, expiry]);

  return (
    <Plot
      data={[
        { x: data.fitX, y: data.fitY, type: 'scatter', mode: 'lines', name: 'SVI 拟合', line: { color: '#38bdf8', width: 2, dash: 'dash' } },
        { x: data.mktX, y: data.mktY, type: 'scatter', mode: 'markers', name: '市场 IV', marker: { color: '#a78bfa', size: 5, opacity: 0.8 } },
        {
          x: data.bumpX, y: data.bumpY, type: 'scatter', mode: 'markers', name: '凸起（做空vol）',
          text: data.bumpT, hovertemplate: '%{text}<extra></extra>',
          marker: { color: '#f87171', size: 12, symbol: 'diamond', line: { color: '#fff', width: 1.5 } },
        },
        {
          x: data.dipX, y: data.dipY, type: 'scatter', mode: 'markers', name: '凹陷（做多vol）',
          text: data.dipT, hovertemplate: '%{text}<extra></extra>',
          marker: { color: '#34d399', size: 12, symbol: 'triangle-up', line: { color: '#fff', width: 1.5 } },
        },
      ]}
      layout={{
        title: { text: `${symbol} ${expiry} IV Skew · ◆红=凸起 ▲绿=凹陷`, font: { color: '#e2e8f0', size: 12 } } as any,
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(15,23,42,0.4)',
        xaxis: { title: { text: '价值度 ln(K/F)/√T' }, color: '#94a3b8', gridcolor: '#1e293b', zerolinecolor: '#334155' },
        yaxis: { title: { text: 'IV (%)' }, color: '#94a3b8', gridcolor: '#1e293b' },
        legend: { font: { color: '#94a3b8', size: 10 }, bgcolor: 'rgba(0,0,0,0.3)' },
        margin: { l: 48, r: 16, t: 40, b: 40 }, font: { color: '#e2e8f0' },
      }}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
