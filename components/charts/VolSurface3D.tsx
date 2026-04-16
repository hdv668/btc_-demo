'use client';

import dynamic from 'next/dynamic';
import { useMemo, useRef, useEffect } from 'react';
import type { IVSurfacePoint, SVIParams } from '@/types';

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

interface Props {
  points: IVSurfacePoint[];
  symbol: string;
  sviParams?: Record<string, SVIParams>;
}

const Z_ANOMALY = 1.5;

/** SVI 总方差 → IV 百分比 */
function sviIVpct(k: number, tte: number, p: SVIParams): number | null {
  if (tte <= 0) return null;
  const w = p.a + p.b * (p.rho * (k - p.m) + Math.sqrt((k - p.m) ** 2 + p.sigma ** 2));
  if (w <= 0) return null;
  const iv = Math.sqrt(w / tte) * 100;
  return iv > 0.5 && iv < 300 ? iv : null;
}

/**
 * PCHIP 单调保形分段三次 Hermite 插值
 * ─────────────────────────────────────────────────────────────────
 * 与自然三次样条的区别：
 *   - 自然样条：C² 连续，但节点间允许振荡（过冲），可以超出节点值范围
 *   - PCHIP：C¹ 连续，但保形——插值值严格在节点值范围内，不振荡
 *
 * 对 SVI 参数（尤其是 a, b, sigma）必须保形，否则插值后出现负值
 * 导致 w(k)<0 → sqrt(负数) → 尖峰或 NaN
 *
 * Fritsch-Carlson 方法确定各节点斜率，保证单调区间内斜率符号一致
 */
function buildPCHIP(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0];
  if (n === 2) return (x: number) => {
    const t = (x - xs[0]) / (xs[1] - xs[0]);
    return ys[0] + (ys[1] - ys[0]) * Math.max(0, Math.min(1, t));
  };

  // 各区间斜率 δ[i] = (y[i+1]-y[i]) / (x[i+1]-x[i])
  const h = Array(n - 1).fill(0).map((_, i) => xs[i + 1] - xs[i]);
  const delta = Array(n - 1).fill(0).map((_, i) => (ys[i + 1] - ys[i]) / h[i]);

  // Fritsch-Carlson 方法计算节点处斜率 m[i]
  const mk = Array(n).fill(0);
  // 端点：单侧斜率
  mk[0] = delta[0];
  mk[n - 1] = delta[n - 2];
  // 内部节点：调和平均，保形
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      mk[i] = 0; // 极值点，斜率为0
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      mk[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  // Fritsch-Carlson 约束：防止单调区间内过冲
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(delta[i]) < 1e-12) {
      mk[i] = mk[i + 1] = 0;
    } else {
      const alpha = mk[i] / delta[i];
      const beta  = mk[i + 1] / delta[i];
      const tau = alpha * alpha + beta * beta;
      if (tau > 9) {
        const scale = 3 / Math.sqrt(tau);
        mk[i]     = scale * alpha * delta[i];
        mk[i + 1] = scale * beta  * delta[i];
      }
    }
  }

  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    // 二分查找区间
    let lo = 0, hi = n - 2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; xs[mid] <= x ? lo = mid : hi = mid - 1; }
    const i = lo;
    const dx = x - xs[i];
    const hi2 = h[i];
    // Hermite 基函数
    const t = dx / hi2;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2*t3 - 3*t2 + 1;
    const h10 = t3 - 2*t2 + t;
    const h01 = -2*t3 + 3*t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * hi2 * mk[i] + h01 * ys[i + 1] + h11 * hi2 * mk[i + 1];
  };
}

/** 用 PCHIP 为5个SVI参数各建一条保形插值曲线，返回任意tte处的插值参数 */
function buildSVISplines(
  tteArr: number[],
  paramsArr: SVIParams[]
): (tte: number) => SVIParams {
  const spA     = buildPCHIP(tteArr, paramsArr.map(p => p.a));
  const spB     = buildPCHIP(tteArr, paramsArr.map(p => p.b));
  const spRho   = buildPCHIP(tteArr, paramsArr.map(p => p.rho));
  const spM     = buildPCHIP(tteArr, paramsArr.map(p => p.m));
  const spSigma = buildPCHIP(tteArr, paramsArr.map(p => p.sigma));
  return (tte: number) => ({
    a:     spA(tte),
    b:     Math.max(spB(tte), 1e-6),
    rho:   Math.max(-0.9999, Math.min(0.9999, spRho(tte))),
    m:     spM(tte),
    sigma: Math.max(spSigma(tte), 1e-6),
    tte,
  });
}

const DEFAULT_CAMERA = {
  eye: { x: 1.8, y: -1.6, z: 1.0 },
  center: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 0, z: 1 },
};

export default function VolSurface3D({ points, symbol, sviParams }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<typeof DEFAULT_CAMERA>(DEFAULT_CAMERA);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const plotDiv = el.querySelector('.js-plotly-plot') as HTMLElement | null;
      if (plotDiv && (window as any).Plotly) {
        const rect = plotDiv.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          (window as any).Plotly.Plots.resize(plotDiv);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { plotData, xTickVals, xTickText } = useMemo(() => {
    if (!points.length) return { plotData: [], xTickVals: [], xTickText: [] };

    const hasSVI = !!(sviParams && Object.keys(sviParams).length > 0);

    // ── 到期日排序 ──────────────────────────────────────────────────
    const expirySet = new Set<string>(points.map(p => p.expiry));
    const expiries = [...expirySet].sort();
    const N = expiries.length;
    if (N === 0) return { plotData: [], xTickVals: [], xTickText: [] };

    // 每个到期日的 tte（优先用 sviParams 里存的，否则从散点取）
    const expTTE: number[] = expiries.map(exp => {
      const sp = sviParams?.[exp];
      if (sp?.tte && sp.tte > 0) return sp.tte;
      const pts = points.filter(p => p.expiry === exp);
      return pts[0]?.tte ?? 0;
    });

    // ── Y 轴：ln(K/F) = moneyness * sqrt(tte) ────────────────────
    // 使用真实 ln(K/F) 作为 Y 轴，可直接代入 SVI 公式，无需再做还原变换
    // 注意：moneyness 字段存储的是 ln(K/F)/√T，所以 k = moneyness * √T
    const allLogK = points.map(p => p.moneyness * Math.sqrt(p.tte));
    const rawKMin = Math.min(...allLogK);
    const rawKMax = Math.max(...allLogK);
    const kMargin = (rawKMax - rawKMin) * 0.12;
    // 裁剪到 [-1.2, 1.2]：超出此范围的点极度虚值，SVI 本就不覆盖
    const kMin = Math.max(rawKMin - kMargin, -1.2);
    const kMax = Math.min(rawKMax + kMargin,  1.2);
    const KY = 60;
    const yArr: number[] = Array.from({ length: KY }, (_, i) => kMin + (i / (KY - 1)) * (kMax - kMin));

    // ATM IV 缓存（每个切片 |moneyness| 最小点的 IV，供 expiryKRange 使用）
    const expiryAtmIV = new Map<string, number>();
    for (const exp of expiries) {
      const pts = points.filter(p => p.expiry === exp);
      if (!pts.length) continue;
      const atm = pts.reduce((a, b) => Math.abs(a.moneyness) < Math.abs(b.moneyness) ? a : b);
      expiryAtmIV.set(exp, Math.max(atm.impliedVol, 0.05));
    }

    // ── X 轴：真实时间轴（tte，年化），cubic spline 插值 ──────────
    // X 轴用真实 tte，平方根刻度（近月密集），
    // SVI 参数用三次样条插值（C² 连续），消除折痕褶皱
    const tteMin = Math.min(...expTTE.filter(t => t > 0));
    const tteMax = Math.max(...expTTE);
    const NX_TARGET = Math.max(80, N * 10);
    const xArr: number[] = [];
    const xTTE: number[] = [];
    const xSVIParams: (SVIParams | null)[] = [];
    const xExpiryIdx: number[] = [];

    // 构建 spline（只用有 SVI 参数的切片作为节点）
    let sviSpline: ((tte: number) => SVIParams) | null = null;
    if (hasSVI) {
      const splineNodes = expiries
        .map((exp, i) => ({ tte: expTTE[i], params: sviParams![exp] }))
        .filter(n => n.params && n.tte > 0)
        .sort((a, b) => a.tte - b.tte);

      if (splineNodes.length >= 2) {
        sviSpline = buildSVISplines(
          splineNodes.map(n => n.tte),
          splineNodes.map(n => n.params)
        );
      } else if (splineNodes.length === 1) {
        // 只有一个切片，退化为常数
        const p = splineNodes[0].params;
        sviSpline = () => p;
      }
    }

    // 平方根刻度采样
    const sqrtMin = Math.sqrt(tteMin);
    const sqrtMax = Math.sqrt(tteMax);
    for (let i = 0; i < NX_TARGET; i++) {
      const sqrtTTE = sqrtMin + (i / (NX_TARGET - 1)) * (sqrtMax - sqrtMin);
      const tte = sqrtTTE * sqrtTTE;
      xArr.push(tte);
      xTTE.push(tte);

      const exactIdx = expTTE.findIndex(t => Math.abs(t - tte) < 1 / 365);
      xExpiryIdx.push(exactIdx >= 0 ? exactIdx : -1);

      if (!sviSpline) { xSVIParams.push(null); continue; }
      xSVIParams.push(sviSpline(tte));
    }

    const NX = xArr.length;

    // ── 构建 SVI 曲面 Z 矩阵 ──────────────────────────────────────
    // Plotly surface: z[i][j] 对应 x[i], y[j]
    // 即 z 是 [NX][KY] 矩阵
    // 所有切片使用统一的 y 范围（kMin～kMax），不做每切片裁剪
    // 原因：按切片裁剪会导致相邻切片在同一 y 位置一个有值一个 null，
    //       产生锯齿/皱褶，曲面不平滑。统一范围 + connectgaps:true 才能得到连续布面。

    let surfTrace: object;

    // 计算每个原始到期日的 ln(K/F) 范围（用于限制曲面外推范围）
    const expiryKRange = new Map<string, { lo: number; hi: number; atmIV: number }>();
    for (const exp of expiries) {
      const pts = points.filter(p => p.expiry === exp);
      if (!pts.length) continue;
      const ks = pts.map(p => p.moneyness * Math.sqrt(p.tte));
      const lo = Math.min(...ks);
      const hi = Math.max(...ks);
      const span = Math.max(hi - lo, 0.05);
      const atm = pts.reduce((a, b) => Math.abs(a.moneyness) < Math.abs(b.moneyness) ? a : b);
      expiryKRange.set(exp, {
        lo: lo - span * 0.2,
        hi: hi + span * 0.2,
        atmIV: atm.impliedVol * 100,
      });
    }

    if (hasSVI) {
      const zArr: (number | null)[][] = [];

      for (let xi = 0; xi < NX; xi++) {
        const tte = xTTE[xi];
        const params = xSVIParams[xi];
        const origIdx = xExpiryIdx[xi];

        if (!params || tte <= 0) {
          zArr.push(yArr.map(() => null));
          continue;
        }

        // 获取该切片对应的 k 范围和 ATM IV（插值点取左右两侧平均）
        let kLo = kMin, kHi = kMax, atmIV = 100;
        if (origIdx >= 0) {
          const r = expiryKRange.get(expiries[origIdx]);
          if (r) { kLo = r.lo; kHi = r.hi; atmIV = r.atmIV; }
        } else {
          // 插值点：按 tte 找左右最近两个真实到期日，线性插值 k 范围
          const curTTE = xTTE[xi];
          let iL2 = 0, iR2 = N - 1;
          for (let j = 0; j < N - 1; j++) {
            if (expTTE[j] <= curTTE && expTTE[j + 1] >= curTTE) { iL2 = j; iR2 = j + 1; break; }
          }
          const rL = expiryKRange.get(expiries[iL2]);
          const rR = expiryKRange.get(expiries[iR2]);
          if (rL && rR && iL2 !== iR2) {
            const dT = expTTE[iR2] - expTTE[iL2];
            const alpha2 = dT > 1e-9 ? (curTTE - expTTE[iL2]) / dT : 0;
            kLo = rL.lo + (rR.lo - rL.lo) * alpha2;
            kHi = rL.hi + (rR.hi - rL.hi) * alpha2;
            atmIV = rL.atmIV + (rR.atmIV - rL.atmIV) * alpha2;
          } else if (rL) { kLo = rL.lo; kHi = rL.hi; atmIV = rL.atmIV; }
          else if (rR) { kLo = rR.lo; kHi = rR.hi; atmIV = rR.atmIV; }
        }

        // Y 轴直接是 ln(K/F)，可以直接代入 SVI，无需还原
        const ivCap = Math.max(atmIV * 3, 150);
        zArr.push(yArr.map(k => {
          if (k < kLo || k > kHi) return null;
          const iv = sviIVpct(k, tte, params);
          if (iv === null) return null;
          return Math.min(iv, ivCap);
        }));
      }

      const hoverText: string[][] = zArr.map((row, xi) => {
        const origIdx = xExpiryIdx[xi];
        const expLabel = origIdx >= 0 ? expiries[origIdx] : '(插值)';
        return row.map((iv, yi) =>
          iv != null
            ? `到期: ${expLabel}<br>ln(K/F): ${yArr[yi].toFixed(3)}<br>理论IV: ${iv.toFixed(1)}%`
            : ''
        );
      });

      surfTrace = {
        type: 'surface',
        x: xArr,
        y: yArr,
        z: zArr,
        text: hoverText,
        hovertemplate: '%{text}<extra>SVI曲面</extra>',
        colorscale: [
          [0,    '#0d2137'],
          [0.15, '#0f3460'],
          [0.35, '#1565a0'],
          [0.55, '#0e9ed6'],
          [0.75, '#39d8a0'],
          [1.0,  '#fde68a'],
        ],
        opacity: 0.85,
        name: 'SVI 拟合曲面（理论公允值）',
        colorbar: {
          title: { text: 'IV %' } as any,
          thickness: 12, len: 0.55,
          tickfont: { color: '#94a3b8', size: 9 },
        },
        showlegend: true,
        lighting: { ambient: 0.65, diffuse: 0.85, roughness: 0.35, specular: 0.25 },
        lightposition: { x: 100, y: 200, z: 500 },
        // false：超出数据范围的 null 处断开，不让 Plotly 跨空洞做乱插值（防鲨鱼鳍）
        connectgaps: false,
      };
    } else {
      // 无 SVI 时，用散点做粗略插值曲面（backup）
      const zArr: (number | null)[][] = [];
      for (let xi = 0; xi < NX; xi++) {
        const origIdx = xExpiryIdx[xi];
        if (origIdx < 0) { zArr.push(yArr.map(() => null)); continue; }
        const exp = expiries[origIdx];
        const slicePts = points.filter(p => p.expiry === exp);
        zArr.push(yArr.map(logK => {
          if (!slicePts.length) return null;
          const nearest = slicePts.reduce((best, p) => {
            const pk = p.moneyness * Math.sqrt(p.tte);
            return Math.abs(pk - logK) < Math.abs(best.moneyness * Math.sqrt(best.tte) - logK) ? p : best;
          });
          const nk = nearest.moneyness * Math.sqrt(nearest.tte);
          if (Math.abs(nk - logK) > 0.08) return null;
          return (nearest.fittedVol ?? nearest.impliedVol) * 100;
        }));
      }
      surfTrace = {
        type: 'surface', x: xArr, y: yArr, z: zArr,
        colorscale: 'Viridis', opacity: 0.82, name: '市场IV曲面（插值）',
        colorbar: { title: { text: 'IV %' } as any, thickness: 12, len: 0.55 },
        hovertemplate: 'ln(K/F): %{y:.3f}<br>IV: %{z:.1f}%<extra>市场曲面</extra>',
      };
    }

    // ── 散点：凸起/凹陷 ──────────────────────────────────────────
    // 散点 x 坐标 = 该到期日的 tte（与曲面 X 轴统一）
    const expiryToX = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      expiryToX.set(expiries[i], expTTE[i]);
    }

    type Pt = { x: number; y: number; zMkt: number; zFit: number; label: string };
    const bumpPts: Pt[] = [];
    const dipPts: Pt[] = [];

    // 去重：同 expiry + strike，只取一个（call/put 选 |zScore| 更大的）
    const dedupKey = new Map<string, typeof points[0]>();
    for (const p of points) {
      if (!p.zScore || Math.abs(p.zScore) < Z_ANOMALY || !p.anomalyType) continue;
      const key = `${p.expiry}-${p.strike}`;
      const cur = dedupKey.get(key);
      if (!cur || Math.abs(p.zScore) > Math.abs(cur.zScore ?? 0)) {
        dedupKey.set(key, p);
      }
    }

    for (const p of dedupKey.values()) {
      const mkt = p.impliedVol * 100;
      const logK = p.moneyness * Math.sqrt(p.tte);

      // zFit：用实时 SVI 公式在该 (logK, tte) 处求曲面高度
      const expiryParams = sviParams?.[p.expiry];
      const sviAtPoint = expiryParams ? sviIVpct(logK, p.tte, expiryParams) : null;
      const fit = sviAtPoint ?? (p.fittedVol ?? p.impliedVol) * 100;

      const diff = mkt - fit;
      const diffStr = diff >= 0
        ? `+${diff.toFixed(1)}pp ▲ 高于曲面`
        : `${diff.toFixed(1)}pp ▼ 低于曲面`;
      const label =
        `${p.expiry}  K=${p.strike}<br>` +
        `市场IV: ${mkt.toFixed(1)}%　理论IV: ${fit.toFixed(1)}%<br>` +
        `偏差: ${diffStr}<br>` +
        `z-score: ${p.zScore!.toFixed(2)}σ  [${p.anomalyType === 'bump' ? '凸起·做空vol' : '凹陷·做多vol'}]`;

      const xVal = expiryToX.get(p.expiry) ?? 0;
      const entry: Pt = { x: xVal, y: logK, zMkt: mkt, zFit: fit, label };
      if (p.anomalyType === 'bump') bumpPts.push(entry);
      else dipPts.push(entry);
    }

    const bumpTrace = {
      type: 'scatter3d',
      x: bumpPts.map(p => p.x),
      y: bumpPts.map(p => p.y),
      z: bumpPts.map(p => p.zMkt),
      mode: 'markers',
      name: '凸起（IV偏高·做空vol）',
      text: bumpPts.map(p => p.label),
      hovertemplate: '%{text}<extra></extra>',
      marker: {
        size: 11,
        color: '#f87171',
        symbol: 'diamond',
        line: { color: '#ffffff', width: 1.5 },
      },
    };

    const dipTrace = {
      type: 'scatter3d',
      x: dipPts.map(p => p.x),
      y: dipPts.map(p => p.y),
      z: dipPts.map(p => p.zMkt),
      mode: 'markers',
      name: '凹陷（IV偏低·做多vol）',
      text: dipPts.map(p => p.label),
      hovertemplate: '%{text}<extra></extra>',
      marker: {
        size: 11,
        color: '#34d399',
        symbol: 'circle',
        line: { color: '#ffffff', width: 1.5 },
      },
    };

    // 散点到曲面的连接线（偏差高度）
    const lineX: (number | null)[] = [];
    const lineY: (number | null)[] = [];
    const lineZ: (number | null)[] = [];
    for (const p of [...bumpPts, ...dipPts]) {
      lineX.push(p.x, p.x, null);
      lineY.push(p.y, p.y, null);
      lineZ.push(p.zMkt, p.zFit, null);
    }
    const lineTrace = {
      type: 'scatter3d',
      x: lineX, y: lineY, z: lineZ,
      mode: 'lines',
      name: '偏差高度',
      showlegend: true,
      line: { color: '#ffffff', width: 2.5 },
      opacity: 0.75,
      hoverinfo: 'skip',
    };

    // ── X 轴 tick：只显示真实到期日（x值=tte）──────────────────────
    const tickStep = N > 16 ? Math.ceil(N / 12) : 1;
    const xTickVals: number[] = [];
    const xTickText: string[] = [];
    expiries.forEach((exp, i) => {
      if (i % tickStep === 0) {
        xTickVals.push(expTTE[i]);        // x = tte
        xTickText.push(exp.slice(5));     // "04-10"
      }
    });

    return {
      plotData: [surfTrace, bumpTrace as object, dipTrace as object, lineTrace as object],
      xTickVals,
      xTickText,
    };
  }, [points, sviParams]);

  if (!points.length) return (
    <div className="flex items-center justify-center h-full text-slate-400 text-sm">暂无数据</div>
  );

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <Plot
        data={plotData as any}
        layout={{
          title: {
            text: `${symbol} 期权IV曲面　红◆=凸起(做空)　绿●=凹陷(做多)　白线=偏差高度`,
            font: { color: '#e2e8f0', size: 12 },
          } as any,
          paper_bgcolor: 'rgba(15,23,42,0)',
          plot_bgcolor: 'rgba(15,23,42,0)',
          scene: {
            xaxis: {
              title: { text: '到期日' },
              tickvals: xTickVals,
              ticktext: xTickText,
              tickfont: { color: '#94a3b8', size: 8 },
              gridcolor: '#1e3a5f',
              color: '#94a3b8',
            },
            yaxis: {
              title: { text: 'ln(K/F)' },
              tickfont: { color: '#94a3b8', size: 8 },
              gridcolor: '#1e3a5f',
              color: '#94a3b8',
            },
            zaxis: {
              title: { text: 'IV (%)' },
              tickfont: { color: '#94a3b8', size: 8 },
              gridcolor: '#1e3a5f',
              color: '#94a3b8',
            },
            bgcolor: 'rgba(10,18,40,0.7)',
            camera: cameraRef.current,
            aspectmode: 'cube',
            dragmode: 'turntable',
          },
          legend: {
            font: { color: '#94a3b8', size: 10 },
            bgcolor: 'rgba(0,0,0,0.45)',
            x: 0,
            y: 1,
          },
          margin: { l: 0, r: 0, t: 44, b: 0 },
          font: { color: '#e2e8f0' },
        }}
        config={{
          displayModeBar: true,
          displaylogo: false,
          responsive: true,
          scrollZoom: true,
        }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
        onRelayout={(e: any) => {
          const cam = e['scene.camera'];
          if (cam) cameraRef.current = cam;
        }}
      />
    </div>
  );
}
