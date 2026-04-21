'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { IVPoint } from '@/app/api/iv-surface/route';
import type { RNDPoint, SVIParams, RNDResponse } from '@/app/api/rnd-surface/route';

type SurfaceMode = 'iv' | 'rnd';

interface Props {
  points: IVPoint[];
  sigmaThreshold: number;
  onPointClick?: (point: IVPoint) => void;
  selectedInstrument?: string;
  // sviParams/rndSlices 保留兼容性，但不再从外部传入（由组件内部懒加载）
  sviParams?: Record<string, SVIParams>;
  rndSlices?: Record<string, RNDPoint[]>;
  exchange?: string;
}

// ─────────────────────────────────────────────────────────────
//  RBF Cubic 插值（IV 曲面用）
// ─────────────────────────────────────────────────────────────
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

  const Phi: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = nx[i] - nx[j], dy = ny[i] - ny[j];
      const r = Math.sqrt(dx * dx + dy * dy);
      Phi[i][j] = r * r * r;
    }
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

function linspace(start: number, end: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + (i / (n - 1)) * (end - start));
}

export default function IVSurface3D({
  points, sigmaThreshold, onPointClick, selectedInstrument, exchange = 'deribit',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SurfaceMode>('iv');

  // ── 懒加载 RND 数据 ───────────────────────────────────────────
  const [rndLoading, setRndLoading] = useState(false);
  const [rndError, setRndError] = useState<string | null>(null);
  const [rndSlices, setRndSlices] = useState<Record<string, RNDPoint[]> | null>(null);

  const loadRND = useCallback(async () => {
    if (rndSlices || rndLoading) return; // 已有数据或正在加载，不重复请求
    setRndLoading(true);
    setRndError(null);
    try {
      const headers: Record<string, string> = {};

      // 直接从 localStorage 读取，避免状态同步问题
      try {
        const saved = localStorage.getItem('btc-iv-proxy-settings');
        if (saved) {
          const settings = JSON.parse(saved);
          if (settings.enabled) {
            headers['x-proxy-url'] = `http://${settings.host}:${settings.port}`;
          }
        }
      } catch (e) {
        // 静默失败
      }

      const url = new URL('/api/rnd-surface', window.location.origin);
      url.searchParams.set('exchange', exchange);

      const res = await fetch(url.toString(), { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RNDResponse = await res.json();
      setRndSlices(data.rndSlices);
    } catch (e: any) {
      setRndError(e.message ?? '加载失败');
    } finally {
      setRndLoading(false);
    }
  }, [rndSlices, rndLoading, exchange]);

  const handleClickRND = useCallback(() => {
    setMode('rnd');
    loadRND();
  }, [loadRND]);

  const validPoints = useMemo(
    () => points.filter(p => p.iv > 0 && p.tenor > 0 && p.strike > 0),
    [points]
  );

  const normalPoints    = useMemo(() => validPoints.filter(p => p.anomalyType === 'normal'),      [validPoints]);
  const overpricedPoints = useMemo(() => validPoints.filter(p => p.anomalyType === 'overpriced'), [validPoints]);
  const underpricedPoints = useMemo(() => validPoints.filter(p => p.anomalyType === 'underpriced'),[validPoints]);

  // ── 准备 RND 数据 ──────────────────────────────────────────
  const rndData = useMemo(() => {
    if (!rndSlices) return null;
    const entries = Object.entries(rndSlices)
      .filter(([, pts]) => pts.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return null;
    return entries; // [ [expiry, RNDPoint[]], ... ]
  }, [rndSlices]);

  useEffect(() => {
    if (!containerRef.current || validPoints.length < 6) return;

    import('plotly.js-dist-min').then((Plotly: any) => {
      if (mode === 'iv') {
        renderIVMode(Plotly);
      } else {
        renderRNDMode(Plotly);
      }
    });

    return () => {
      import('plotly.js-dist-min').then((Plotly: any) => {
        if (containerRef.current) Plotly.purge(containerRef.current);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validPoints, normalPoints, overpricedPoints, underpricedPoints,
      sigmaThreshold, selectedInstrument, onPointClick, mode, rndData]);

  // ── IV 曲面渲染（原逻辑）─────────────────────────────────
  function renderIVMode(Plotly: any) {
    const srcK = validPoints.map(p => p.strike);
    const srcT = validPoints.map(p => p.tenor);
    const srcIVSurface = validPoints.map(p => p.ivSurface);

    const GRID = 50;
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
        '<b>🔴 OVERPRICED — 点击查看分析</b><br><b>%{customdata[0]}</b><br>' +
        'Strike: $%{x:,.0f} | Tenor: %{y:.0f}d<br>' +
        'IV_mkt: %{z:.1f}% → Base: %{customdata[1]:.1f}%<br>' +
        'ε: +%{customdata[2]:.1f}% (σ阈值=%{customdata[3]:.1f}%)<br>' +
        'EV: $%{customdata[4]:.0f} | 胜率: %{customdata[5]:.0f}%<br>%{customdata[6]}' +
        '<i>Short Vega：做空波动率</i><extra></extra>',
      customdata: overpricedPoints.map(p => [
        p.instrument, +(p.ivSurface * 100).toFixed(2), +(p.residual * 100).toFixed(2), +sigPct,
        p.tradeAnalysis ? +p.tradeAnalysis.ev.toFixed(0) : 0,
        p.tradeAnalysis ? +(p.tradeAnalysis.winProb * 100).toFixed(0) : 0,
        p.stressInjected ? `⚗ 压力注入 ${(p.stressAmt! * 100).toFixed(0)}%<br>` : '',
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
        '<b>🟢 UNDERPRICED — 点击查看分析</b><br><b>%{customdata[0]}</b><br>' +
        'Strike: $%{x:,.0f} | Tenor: %{y:.0f}d<br>' +
        'IV_mkt: %{z:.1f}% → Base: %{customdata[1]:.1f}%<br>' +
        'ε: %{customdata[2]:.1f}% (-σ阈值=-%{customdata[3]:.1f}%)<br>' +
        'EV: $%{customdata[4]:.0f} | 胜率: %{customdata[5]:.0f}%<br>%{customdata[6]}' +
        '<i>Long Vega：做多波动率</i><extra></extra>',
      customdata: underpricedPoints.map(p => [
        p.instrument, +(p.ivSurface * 100).toFixed(2), +(p.residual * 100).toFixed(2), +sigPct,
        p.tradeAnalysis ? +p.tradeAnalysis.ev.toFixed(0) : 0,
        p.tradeAnalysis ? +(p.tradeAnalysis.winProb * 100).toFixed(0) : 0,
        p.stressInjected ? `⚗ 压力注入 ${(p.stressAmt! * 100).toFixed(0)}%<br>` : '',
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

  // ── RND 曲面渲染（Breeden-Litzenberger 概率密度）────────────
  function renderRNDMode(Plotly: any) {
    if (!rndData || rndData.length === 0) {
      Plotly.react(containerRef.current!, [], {
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        annotations: [{ text: '暂无 RND 数据（需 SVI 拟合成功）', x: 0.5, y: 0.5, xref: 'paper', yref: 'paper', showarrow: false, font: { color: '#94a3b8', size: 14 } }],
      }, { responsive: true, displaylogo: false });
      return;
    }

    // 构建 3D 曲面：X = Strike，Y = 到期日（天），Z = 密度 q(K)
    // 所有切片共享统一的 K 轴（取各切片 K 的并集后插值对齐）
    const expiries = rndData.map(([exp]) => exp);
    const tDays = rndData.map(([, pts]) => Math.round(pts[0].tte * 365));

    // 统一 K 轴：取最宽 K 范围的 200 格
    const allStrikes = rndData.flatMap(([, pts]) => pts.map(p => p.strike));
    const kMin = Math.min(...allStrikes), kMax = Math.max(...allStrikes);
    const kUniform = linspace(kMin, kMax, 200);

    // 对每个到期日切片在统一 K 轴上线性插值密度
    const zMatrix: number[][] = rndData.map(([, pts]) => {
      const srcK = pts.map(p => p.strike);
      const srcD = pts.map(p => p.density);
      return kUniform.map(K => {
        // 线性插值
        if (K <= srcK[0]) return srcD[0];
        if (K >= srcK[srcK.length - 1]) return srcD[srcK.length - 1];
        let lo = 0, hi = srcK.length - 1;
        while (lo < hi - 1) { const mid = (lo + hi) >> 1; srcK[mid] <= K ? lo = mid : hi = mid; }
        const t = (K - srcK[lo]) / (srcK[hi] - srcK[lo]);
        return srcD[lo] + t * (srcD[hi] - srcD[lo]);
      });
    });

    // 颜色：深蓝（低密度）→ 青色 → 金色（高密度 / 众数区）
    const rndSurface = {
      type: 'surface',
      name: 'RND 概率密度曲面',
      x: kUniform,
      y: tDays,
      z: zMatrix,
      colorscale: [
        [0.0,  '#0d2137'],
        [0.2,  '#0f4c81'],
        [0.4,  '#0e9ed6'],
        [0.6,  '#39d8a0'],
        [0.8,  '#fbbf24'],
        [1.0,  '#f97316'],
      ],
      colorbar: {
        title: { text: 'q(K)', font: { color: '#94a3b8', size: 11 } },
        tickfont: { color: '#94a3b8', size: 9 },
        thickness: 12, len: 0.55, x: 1.02,
      },
      opacity: 0.88,
      lighting: { ambient: 0.6, diffuse: 0.85, roughness: 0.4, specular: 0.2 },
      hovertemplate:
        '<b>风险中性密度</b><br>' +
        'Strike: $%{x:,.0f}<br>' +
        'Tenor: %{y}d<br>' +
        'q(K): %{z:.6f}<extra>BL密度</extra>',
      showlegend: true,
    };

    // 每个到期日叠加 IV 折线（z=密度，展示 skew 形状）
    const ivTraces = rndData.map(([exp, pts]) => ({
      type: 'scatter3d',
      name: `${exp} SVI-IV`,
      mode: 'lines',
      x: pts.map(p => p.strike),
      y: pts.map(() => Math.round(pts[0].tte * 365)),
      z: pts.map(() => 0), // 贴底面，作为 x 轴投影参考
      line: { color: '#94a3b8', width: 1.5 },
      opacity: 0.5,
      hoverinfo: 'skip',
      showlegend: false,
    }));

    // 叠加各到期日众数（密度峰值）的垂直竖线
    const modeMarkers = rndData.map(([exp, pts]) => {
      const maxIdx = pts.reduce((best, p, i) => p.density > pts[best].density ? i : best, 0);
      const peak = pts[maxIdx];
      return {
        type: 'scatter3d',
        name: `${exp} 众数 $${peak.strike.toFixed(0)}`,
        mode: 'markers+text',
        x: [peak.strike],
        y: [Math.round(peak.tte * 365)],
        z: [peak.density],
        text: [`$${(peak.strike / 1000).toFixed(0)}k`],
        textposition: 'top center',
        textfont: { color: '#fbbf24', size: 8 },
        marker: { size: 6, color: '#fbbf24', symbol: 'diamond', line: { color: '#fff', width: 1 } },
        hovertemplate: `<b>${exp}</b><br>众数: $${peak.strike.toFixed(0)}<br>密度峰值: ${peak.density.toFixed(6)}<extra></extra>`,
        showlegend: true,
      };
    });

    const layout = {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#94a3b8', family: 'Inter, system-ui, sans-serif', size: 11 },
      margin: { l: 0, r: 10, b: 0, t: 30 },
      title: {
        text: 'BTC 风险中性概率密度曲面（Breeden-Litzenberger）',
        font: { color: '#e2e8f0', size: 12 },
        x: 0.5,
      },
      legend: {
        font: { color: '#94a3b8', size: 9 }, bgcolor: 'rgba(2,6,23,0.7)',
        bordercolor: '#1e293b', borderwidth: 1, x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top',
      },
      scene: {
        bgcolor: 'rgba(2,6,23,0)',
        xaxis: {
          title: { text: 'Strike K (USD)', font: { color: '#64748b', size: 11 } },
          tickfont: { color: '#475569', size: 9 }, gridcolor: '#1e293b', zerolinecolor: '#334155',
        },
        yaxis: {
          title: { text: 'Tenor (Days)', font: { color: '#64748b', size: 11 } },
          tickfont: { color: '#475569', size: 9 }, gridcolor: '#1e293b', zerolinecolor: '#334155',
        },
        zaxis: {
          title: { text: 'q(K)  概率密度', font: { color: '#64748b', size: 11 } },
          tickfont: { color: '#475569', size: 9 }, gridcolor: '#1e293b', zerolinecolor: '#334155',
        },
        camera: { eye: { x: 1.7, y: -1.5, z: 0.9 } },
      },
      showlegend: true,
    };

    const config = { responsive: true, displayModeBar: true, displaylogo: false };
    Plotly.react(containerRef.current!, [rndSurface, ...modeMarkers], layout, config);
  }

  if (validPoints.length < 6) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        有效数据点不足（{validPoints.length} 个），无法构建曲面
      </div>
    );
  }

  const hasRND = rndData && rndData.length > 0;

  return (
    <div className="relative w-full h-full flex flex-col">
      {/* 模式切换按钮 */}
      <div className="absolute top-2 right-2 z-10 flex rounded-lg overflow-hidden border border-slate-700 bg-slate-900/80 backdrop-blur">
        <button
          onClick={() => setMode('iv')}
          className={`px-3 py-1.5 text-xs font-medium transition-all
            ${mode === 'iv'
              ? 'bg-blue-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
        >
          IV 曲面
        </button>
        <button
          onClick={handleClickRND}
          disabled={rndLoading}
          className={`px-3 py-1.5 text-xs font-medium transition-all disabled:cursor-wait
            ${mode === 'rnd'
              ? 'bg-orange-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
          title="Breeden-Litzenberger 风险中性概率密度"
        >
          {rndLoading ? '计算中…' : 'RND 密度'}
        </button>
      </div>

      {/* 模式说明 */}
      {mode === 'rnd' && !rndError && (
        <div className="absolute bottom-2 left-2 z-10 text-xs text-slate-500 bg-slate-900/70 rounded px-2 py-1 pointer-events-none max-w-sm">
          Z轴 = q(K) = e^rT · ∂²C/∂K²（Breeden-Litzenberger）&nbsp;·&nbsp;
          金色菱形 = 各到期日密度众数（市场最大概率落点）
        </div>
      )}
      {mode === 'rnd' && rndError && (
        <div className="absolute bottom-2 left-2 z-10 text-xs text-red-400 bg-slate-900/70 rounded px-2 py-1 max-w-sm">
          RND 加载失败：{rndError}
        </div>
      )}

      <div ref={containerRef} className="w-full flex-1" />
    </div>
  );
}
