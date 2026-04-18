'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { IVPoint } from '@/app/api/iv-surface/route';
import type { RNDPoint, SVIParams } from '@/app/api/rnd-surface/route';

type SurfaceMode = 'iv' | 'rnd';

interface Props {
  points: IVPoint[];
  sigmaThreshold: number;
  onPointClick?: (point: IVPoint) => void;
  selectedInstrument?: string;
  sviParams?: Record<string, SVIParams>;
  rndSlices?: Record<string, RNDPoint[]>;
}

function linspace(start: number, end: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + (i / (n - 1)) * (end - start));
}

export default function IVSurface3D({
  points, sigmaThreshold, onPointClick, selectedInstrument,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const validPoints = useMemo(
    () => points.filter(p => p.iv > 0 && p.tenor > 0 && p.strike > 0),
    [points]
  );

  const normalPoints    = useMemo(() => validPoints.filter(p => p.anomalyType === 'normal'),      [validPoints]);
  const overpricedPoints = useMemo(() => validPoints.filter(p => p.anomalyType === 'overpriced'), [validPoints]);
  const underpricedPoints = useMemo(() => validPoints.filter(p => p.anomalyType === 'underpriced'),[validPoints]);

  useEffect(() => {
    if (!containerRef.current || validPoints.length < 6) return;

    import('plotly.js-dist-min').then((Plotly: any) => {
      renderIVMode(Plotly);
    });

    return () => {
      import('plotly.js-dist-min').then((Plotly: any) => {
        if (containerRef.current) Plotly.purge(containerRef.current);
      });
    };
  }, [validPoints, normalPoints, overpricedPoints, underpricedPoints,
      sigmaThreshold, selectedInstrument, onPointClick]);

  // ── 简单的 RBF 插值 ─────────────────────────────────────────
  function rbfCubicGrid(
    srcX: number[], srcY: number[], srcZ: number[],
    kGrid: number[], tGrid: number[]
  ): number[][] {
    const n = srcX.length;
    const xMin = Math.min(...srcX), xMax = Math.max(...srcX);
    const yMin = Math.min(...srcY), yMax = Math.max(...srcY);
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    const nx = srcX.map(v => (v - xMin) / xRange);
    const ny = srcY.map(v => (v - yMin) / yRange);

    const lambdaSmooth = 0.2;
    const Phi: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const dx = nx[i] - nx[j], dy = ny[i] - ny[j];
        const r = Math.sqrt(dx * dx + dy * dy);
        Phi[i][j] = r * r * r;
      }
      Phi[i][i] += lambdaSmooth;
    }

    const aug = Phi.map((row, i) => [...row, srcZ[i]]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-12) continue;
      for (let row = col + 1; row < n; row++) {
        const f = aug[row][col] / pivot;
        for (let k = col; k <= n; k++) aug[row][k] -= f * aug[col][k];
      }
    }
    const w = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      w[i] = aug[i][n];
      for (let j = i + 1; j < n; j++) w[i] -= aug[i][j] * w[j];
      w[i] /= aug[i][i] || 1;
    }

    const nkGrid = kGrid.map(v => (v - xMin) / xRange);
    const ntGrid = tGrid.map(v => (v - yMin) / yRange);

    return ntGrid.map(nty => {
      return nkGrid.map(nkx => {
        let val = 0;
        for (let i = 0; i < n; i++) {
          const dx = nkx - nx[i], dy = nty - ny[i];
          const r = Math.sqrt(dx * dx + dy * dy);
          val += w[i] * r * r * r;
        }
        return Math.max(val * 100, 0);
      });
    });
  }

  function renderIVMode(Plotly: any) {
    const srcK = validPoints.map(p => p.strike);
    const srcT = validPoints.map(p => p.tenor);
    const srcIVSurface = validPoints.map(p => p.ivSurface);

    const GRID = 40;
    const kGrid = linspace(Math.min(...srcK), Math.max(...srcK), GRID);
    const tGrid = linspace(Math.min(...srcT), Math.max(...srcT), GRID);
    const ivGrid = rbfCubicGrid(srcK, srcT, srcIVSurface, kGrid, tGrid);

    const tDays = tGrid.map(t => +(t * 365).toFixed(1));
    const sigPct = (sigmaThreshold * 100).toFixed(1);

    const surfaceTrace = {
      type: 'surface',
      name: '定价基准曲面',
      x: kGrid,
      y: tDays,
      z: ivGrid,
      colorscale: [
        [0.0,  '#1e3a5f'],
        [0.25, '#1d6fa4'],
        [0.5,  '#22d3ee'],
        [0.75, '#fbbf24'],
        [1.0,  '#dc2626'],
      ],
      colorbar: {
        title: { text: 'IV (%)', font: { color: '#94a3b8', size: 11 } },
        tickfont: { color: '#94a3b8', size: 9 },
        thickness: 12, len: 0.55, x: 1.02,
      },
      opacity: 0.50,
      lighting: { diffuse: 0.85, specular: 0.2, roughness: 0.6 },
      contours: { z: { show: false } },
      hovertemplate:
        '<b>基准曲面</b><br>Strike: $%{x:,.0f}<br>Tenor: %{y:.0f}d<br>IV_surface: %{z:.1f}%<extra></extra>',
      showlegend: true,
    };

    const normalTrace = {
      type: 'scatter3d', name: `正常合约 (${normalPoints.length})`, mode: 'markers',
      x: normalPoints.map(p => p.strike),
      y: normalPoints.map(p => +(p.tenor * 365).toFixed(1)),
      z: normalPoints.map(p => +(p.iv * 100).toFixed(2)),
      marker: { size: 2, color: 'rgba(148,163,184,0.35)', symbol: 'circle' },
      hovertemplate:
        '<b>%{text}</b><br>Strike: $%{x:,.0f}<br>Tenor: %{y:.0f}d<br>IV_mkt: %{z:.1f}%<extra>正常</extra>',
      text: normalPoints.map(p => p.instrument),
      showlegend: true,
    };

    const makeOverSize  = (p: IVPoint) => p.instrument === selectedInstrument ? 11 : p.stressInjected ? 9 : 7;
    const makeUnderSize = (p: IVPoint) => p.instrument === selectedInstrument ? 11 : p.stressInjected ? 9 : 7;

    const overpricedTrace = {
      type: 'scatter3d', name: `高估 Overpriced (${overpricedPoints.length})`,
      mode: 'markers+text',
      x: overpricedPoints.map(p => p.strike),
      y: overpricedPoints.map(p => +(p.tenor * 365).toFixed(1)),
      z: overpricedPoints.map(p => +(p.iv * 100).toFixed(2)),
      marker: {
        size: overpricedPoints.map(makeOverSize),
        color: overpricedPoints.map(p => p.instrument === selectedInstrument ? '#ff9999' : '#ef4444'),
        symbol: 'diamond', opacity: 0.95,
        line: {
          color: overpricedPoints.map(p =>
            p.instrument === selectedInstrument ? '#ffffff' : p.stressInjected ? '#fb923c' : '#fca5a5'),
          width: overpricedPoints.map(p => p.instrument === selectedInstrument ? 2 : p.stressInjected ? 2.5 : 1),
        },
      },
      text: overpricedPoints.length <= 8
        ? overpricedPoints.map(p => p.stressInjected ? '⚗' : '▲') : overpricedPoints.map(() => ''),
      textfont: { color: '#fca5a5', size: 9 },
      textposition: 'top center',
      hovertemplate:
        '<b>🔴 OVERPRICED</b><br><b>%{customdata[0]}</b><br>' +
        'Strike: $%{x:,.0f} | Tenor: %{y:.0f}d<br>' +
        'IV_mkt: %{z:.1f}% → Base: %{customdata[1]:.1f}%<extra></extra>',
      customdata: overpricedPoints.map(p => [
        p.instrument, +(p.ivSurface * 100).toFixed(2),
      ]),
      showlegend: true,
    };

    const underpricedTrace = {
      type: 'scatter3d', name: `低估 Underpriced (${underpricedPoints.length})`,
      mode: 'markers+text',
      x: underpricedPoints.map(p => p.strike),
      y: underpricedPoints.map(p => +(p.tenor * 365).toFixed(1)),
      z: underpricedPoints.map(p => +(p.iv * 100).toFixed(2)),
      marker: {
        size: underpricedPoints.map(makeUnderSize),
        color: underpricedPoints.map(p => p.instrument === selectedInstrument ? '#99ffcc' : '#22c55e'),
        symbol: 'diamond', opacity: 0.95,
        line: {
          color: underpricedPoints.map(p =>
            p.instrument === selectedInstrument ? '#ffffff' : p.stressInjected ? '#fb923c' : '#86efac'),
          width: underpricedPoints.map(p => p.instrument === selectedInstrument ? 2 : p.stressInjected ? 2.5 : 1),
        },
      },
      text: underpricedPoints.length <= 8
        ? underpricedPoints.map(p => p.stressInjected ? '⚗' : '▼') : underpricedPoints.map(() => ''),
      textfont: { color: '#86efac', size: 9 },
      textposition: 'top center',
      hovertemplate:
        '<b>🟢 UNDERPRICED</b><br><b>%{customdata[0]}</b><br>' +
        'Strike: $%{x:,.0f} | Tenor: %{y:.0f}d<br>' +
        'IV_mkt: %{z:.1f}% → Base: %{customdata[1]:.1f}%<extra></extra>',
      customdata: underpricedPoints.map(p => [
        p.instrument, +(p.ivSurface * 100).toFixed(2),
      ]),
      showlegend: true,
    };

    const layout = {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#94a3b8', family: 'Inter, system-ui, sans-serif', size: 11 },
      margin: { l: 0, r: 10, b: 0, t: 0 },
      legend: {
        font: { color: '#94a3b8', size: 10 }, bgcolor: 'rgba(2,6,23,0.7)',
        bordercolor: '#1e293b', borderwidth: 1, x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top',
      },
      scene: {
        bgcolor: 'rgba(2,6,23,0)',
        xaxis: { title: { text: 'Strike (K)', font: { color: '#64748b', size: 11 } }, tickfont: { color: '#475569', size: 9 }, gridcolor: '#1e293b', zerolinecolor: '#334155' },
        yaxis: { title: { text: 'Tenor (Days)', font: { color: '#64748b', size: 11 } }, tickfont: { color: '#475569', size: 9 }, gridcolor: '#1e293b', zerolinecolor: '#334155' },
        zaxis: { title: { text: 'IV (%)', font: { color: '#64748b', size: 11 } }, tickfont: { color: '#475569', size: 9 }, gridcolor: '#1e293b', zerolinecolor: '#334155' },
        camera: { eye: { x: 1.55, y: -1.55, z: 0.85 } },
      },
      showlegend: true,
    };

    const config = { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'] };

    Plotly.react(containerRef.current!, [surfaceTrace, normalTrace, overpricedTrace, underpricedTrace], layout, config);

    if (onPointClick) {
      const el = containerRef.current!;
      (el as any)._ivClickHandler && el.removeEventListener('plotly_click', (el as any)._ivClickHandler);
      const handler = (eventData: any) => {
        if (!eventData?.points?.length) return;
        const pt = eventData.points[0];
        const { curveNumber, pointNumber } = pt;
        let clickedPoint: IVPoint | undefined;
        if (curveNumber === 2) clickedPoint = overpricedPoints[pointNumber];
        else if (curveNumber === 3) clickedPoint = underpricedPoints[pointNumber];
        if (clickedPoint) onPointClick(clickedPoint);
      };
      el.on('plotly_click', handler);
      (el as any)._ivClickHandler = handler;
    }
  }

  if (validPoints.length < 6) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        有效数据点不足（{validPoints.length} 个），无法构建曲面
      </div>
    );
  }

  return <div ref={containerRef} className="w-full h-full" />;
}
