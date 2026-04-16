/**
 * Dupire 局部波动率（Local Volatility）
 *
 * 架构：两层计算
 *
 * 第一层：SVI-implied LocalVol 基准曲面
 *   用 SVI 拟合参数（光滑解析曲面）计算每个 (K, T) 的 Dupire localVol
 *   → 这是"模型期望的局部波动率"，是后续异常检测的基准
 *
 * 第二层：散点实际 LocalVol + 残差分析
 *   对每个真实散点（market IV），用 Black-Scholes 有限差分反推其对应的 localVol
 *   与基准曲面对比：lvResidual = 实际localVol - 基准localVol
 *   对全曲面残差做跨期日归一化 → lvZScore
 *
 * 凸起/凹陷定义：
 *   lvZScore > 阈值 → localVol 曲面凸起（该点定价偏贵，做空 vol 机会）
 *   lvZScore < -阈值 → localVol 曲面凹陷（该点定价偏宜，做多 vol 机会）
 *
 * Gatheral Dupire 公式（用 w(k,T) 表达）：
 *   σ²_local = (∂w/∂T) / [1 - k/w·∂w/∂k + ¼(-¼-1/w+k²/w²)(∂w/∂k)² + ½·∂²w/∂k²]
 *   其中 k = ln(K/F), w = σ_IV² · T
 */

import type { IVSurfacePoint, SVIParams, LocalVolPoint } from '@/types';
import { sviTotalVar } from './svi';

const RISK_FREE = 0.05;

// ─── 单点 Dupire（基于 SVI 解析微分）─────────────────────────────────
/**
 * 给定 (K, T) 和 SVI 参数，用解析微分计算局部波动率。
 * 这是"SVI-implied localVol"，作为光滑基准。
 */
export function dupireLocalVol(
  K: number,
  F: number,
  T: number,
  params: SVIParams,
  paramsNext: SVIParams | null,
  T2: number | null,
): number | null {
  if (T <= 1e-6) return null;

  const k = Math.log(K / F);

  const w = sviTotalVar(k, params);
  if (w <= 0) return null;

  // ── dw/dk 解析微分 ────────────────────────────────────────────────
  const { b, rho, m, sigma } = params;
  const km = k - m;
  const sqrtKm = Math.sqrt(km * km + sigma * sigma);
  const dwdk = b * (rho + km / sqrtKm);

  // ── d²w/dk² 解析微分 ──────────────────────────────────────────────
  const d2wdk2 = b * sigma * sigma / Math.pow(km * km + sigma * sigma, 1.5);

  // ── dw/dT 差分（相邻切片）────────────────────────────────────────
  let dwdT: number;
  if (paramsNext && T2 && T2 > T) {
    const w2 = sviTotalVar(k, paramsNext);
    dwdT = (w2 - w) / (T2 - T);
  } else {
    dwdT = w / T; // 无相邻切片：线性增长假设
  }

  if (dwdT <= 0) return null; // 违反日历无套利

  // ── Gatheral Dupire 公式 ──────────────────────────────────────────
  const term1 = (1 - (k * dwdk) / (2 * w)) ** 2;
  const term2 = (dwdk ** 2 / 4) * (1 / w + 0.25);
  const term3 = d2wdk2 / 2;
  const g = term1 - term2 + term3;

  if (g <= 1e-8) return null; // 违反蝶式无套利

  const localVarAnnual = dwdT / g;
  if (localVarAnnual <= 0) return null;

  return Math.sqrt(localVarAnnual);
}

// ─── 用散点 IV 有限差分反推 LocalVol ──────────────────────────────────
/**
 * 给定散点 (K, T, impliedVol)，用相邻点的 IV 数值差分计算该点的 localVol。
 * 结果与 SVI-implied localVol 的差值就是"曲面残差"。
 *
 * 有限差分：
 *   ∂IV/∂T ≈ (IV(K, T₂) - IV(K, T₁)) / (T₂ - T₁)  [跨切片]
 *   ∂IV/∂K ≈ (IV(K+dK) - IV(K-dK)) / (2·dK)         [同切片相邻strike]
 *   ∂²IV/∂K² ≈ (IV(K+dK) - 2·IV(K) + IV(K-dK)) / dK²
 *   然后转换到 Dupire (C → IV 再推导 w)
 *
 * 注意：这里用 BS-Delta 等价的公式直接从 IV 差分推 localVol，
 *   避免先计算期权价格再差分（数值更稳定）：
 *   σ²_local ≈ (∂(IV²T)/∂T) / [1 - k/(IV²T)·∂(IV²T)/∂k + ...]
 *   等价于把散点 IV 当作 SVI，解同样的 Gatheral 公式但用数值差分替代解析微分
 */
function scatterPointLocalVol(
  point: IVSurfacePoint,
  slicePoints: IVSurfacePoint[],   // 同到期日所有散点（按 strike 排序）
  prevSlice: IVSurfacePoint[],     // 前一个到期日散点
  nextSlice: IVSurfacePoint[],     // 后一个到期日散点
  F: number,                       // 远期价
): number | null {
  const { strike: K, tte: T, impliedVol: iv } = point;
  if (T <= 1e-6 || iv <= 0) return null;

  const w = iv * iv * T;
  const k = Math.log(K / F);
  if (w <= 0) return null;

  // ── dw/dk：同切片相邻 strike 差分（改进：非均匀间距中心差分）───────
  const sorted = [...slicePoints].sort((a, b) => a.strike - b.strike);
  const idx = sorted.findIndex(p => p.strike === K);
  if (idx < 0) return null;

  let dwdk: number;
  let d2wdk2: number;

  if (idx > 0 && idx < sorted.length - 1) {
    const prev = sorted[idx - 1];
    const next = sorted[idx + 1];
    const kPrev = Math.log(prev.strike / F);
    const kNext = Math.log(next.strike / F);
    const wPrev = prev.impliedVol * prev.impliedVol * T;
    const wNext = next.impliedVol * next.impliedVol * T;
    // 非均匀间距中心差分（精度更高）
    const hL = k - kPrev;
    const hR = kNext - k;
    dwdk = (wNext * hL * hL - wPrev * hR * hR + w * (hR * hR - hL * hL)) /
           (hL * hR * (hL + hR));
    // 非均匀二阶差分
    d2wdk2 = 2 * (wNext * hL - w * (hL + hR) + wPrev * hR) / (hL * hR * (hL + hR));
  } else if (idx > 0 && idx === sorted.length - 1 && idx >= 2) {
    // 右边界：用左侧三点二阶外推（比简单一阶更准）
    const p0 = sorted[idx - 2];
    const p1 = sorted[idx - 1];
    const k0 = Math.log(p0.strike / F);
    const k1 = Math.log(p1.strike / F);
    const w0 = p0.impliedVol * p0.impliedVol * T;
    const w1 = p1.impliedVol * p1.impliedVol * T;
    const h1 = k1 - k0; const h2 = k - k1;
    dwdk = (w * (2 * h1 + h2) / (h2 * (h1 + h2)) - w1 * (h1 + h2) / (h1 * h2) + w0 * h2 / (h1 * (h1 + h2)));
    d2wdk2 = 2 * (w / (h2 * (h1 + h2)) - w1 / (h1 * h2) + w0 / (h1 * (h1 + h2)));
  } else if (idx < sorted.length - 1) {
    const next = sorted[idx + 1];
    const kNext = Math.log(next.strike / F);
    const wNext = next.impliedVol * next.impliedVol * T;
    dwdk = (wNext - w) / (kNext - k);
    d2wdk2 = 0;
  } else {
    return null; // 只有一个点，无法差分
  }

  // ── dw/dT：相邻切片插值 ─────────────────────────────────────────
  // 找相邻切片中最近 strike 的点来估算时间方向导数
  const findNearestIV = (pts: IVSurfacePoint[]): { iv: number; tte: number } | null => {
    if (pts.length === 0) return null;
    const nearest = pts.reduce((best, p) =>
      Math.abs(p.strike - K) < Math.abs(best.strike - K) ? p : best
    );
    if (Math.abs(nearest.strike - K) / K > 0.05) return null; // strike 差 > 5%，不可靠
    return { iv: nearest.impliedVol, tte: nearest.tte };
  };

  let dwdT: number;
  const prevPt = findNearestIV(prevSlice);
  const nextPt = findNearestIV(nextSlice);

  if (prevPt && nextPt) {
    const wPrev = prevPt.iv * prevPt.iv * prevPt.tte;
    const wNext = nextPt.iv * nextPt.iv * nextPt.tte;
    dwdT = (wNext - wPrev) / (nextPt.tte - prevPt.tte);
  } else if (nextPt) {
    const wNext = nextPt.iv * nextPt.iv * nextPt.tte;
    dwdT = (wNext - w) / (nextPt.tte - T);
  } else if (prevPt) {
    const wPrev = prevPt.iv * prevPt.iv * prevPt.tte;
    dwdT = (w - wPrev) / (T - prevPt.tte);
  } else {
    dwdT = w / T; // 兜底
  }

  if (dwdT <= 0) return null;

  // ── Gatheral Dupire 公式 ─────────────────────────────────────────
  const term1 = (1 - (k * dwdk) / (2 * w)) ** 2;
  const term2 = (dwdk ** 2 / 4) * (1 / w + 0.25);
  const term3 = d2wdk2 / 2;
  const g = term1 - term2 + term3;

  if (g <= 1e-8) return null;

  const localVarAnnual = dwdT / g;
  if (localVarAnnual <= 0) return null;

  const lv = Math.sqrt(localVarAnnual);
  // 合理范围：
  //   - 不能低于 1%（数值噪音）
  //   - 不能超过 min(iv*2.5, 3.5)（差分放大效应，BTC期权LocalVol可能显著高于IV，但不能太离谱）
  //   - 绝对上限 3.5（350%）
  if (lv < 0.01 || lv > Math.min(iv * 2.5, 3.5)) return null;

  return lv;
}

// ─── 全曲面：SVI-implied LocalVol 基准 ────────────────────────────────
/**
 * 从 SVI 参数生成光滑的基准 LocalVol 曲面（供 3D 渲染和残差计算用）
 */
export function computeLocalVolSurface(
  underlyingPrice: number,
  sviParams: Record<string, SVIParams>,
): LocalVolPoint[] {
  const expiries = Object.keys(sviParams).sort();
  if (expiries.length < 1) return [];

  const result: LocalVolPoint[] = [];

  for (let ei = 0; ei < expiries.length; ei++) {
    const expiry = expiries[ei];
    const params = sviParams[expiry];
    const tte = parseTTE(expiry);
    if (tte <= 0) continue;

    const F = underlyingPrice * Math.exp(RISK_FREE * tte);
    const paramsNext = expiries[ei + 1] ? sviParams[expiries[ei + 1]] : null;
    const T2 = expiries[ei + 1] ? parseTTE(expiries[ei + 1]) : null;

    // k ∈ [-0.5, 0.5]，21 个采样点
    for (let ki = 0; ki <= 20; ki++) {
      const kVal = -0.5 + ki * 0.05;
      const K = F * Math.exp(kVal);

      const lv = dupireLocalVol(K, F, tte, params, paramsNext, T2);
      if (lv === null || lv < 0.01 || lv > 5) continue;

      result.push({ strike: Math.round(K), tte, localVol: lv });
    }
  }

  return result;
}

// ─── 核心：散点 LocalVol 残差分析 ────────────────────────────────────
/**
 * 对所有散点计算：
 *   1. 用有限差分反推该点实际 localVol（impliedLocalVol）
 *   2. 用 SVI 解析公式算基准 localVol（baselineLocalVol）
 *   3. 残差 = (impliedLocalVol - baselineLocalVol) / baselineLocalVol（相对残差）
 *   4. 对全曲面所有残差做归一化 → lvZScore
 *
 * 返回：每个点附加 { baselineLocalVol, lvResidual, lvZScore } 的完整数组
 */
export function computeLVResiduals(
  points: IVSurfacePoint[],
  underlyingPrice: number,
  sviParams: Record<string, SVIParams>,
): IVSurfacePoint[] {
  if (points.length === 0) return points;

  // 按到期日分组
  const byExpiry = new Map<string, IVSurfacePoint[]>();
  for (const p of points) {
    if (!byExpiry.has(p.expiry)) byExpiry.set(p.expiry, []);
    byExpiry.get(p.expiry)!.push(p);
  }

  const sortedExpiries = [...byExpiry.keys()].sort();

  // strike → { impliedLV, baselineLV, relResidual } 的映射（每个到期日独立）
  // key: `${expiry}-${strike}`
  const lvByKey = new Map<string, {
    impliedLV: number | null;
    baselineLV: number | null;
    relResidual: number | null;
  }>();

  for (let ei = 0; ei < sortedExpiries.length; ei++) {
    const expiry = sortedExpiries[ei];
    const rawSlice = byExpiry.get(expiry)!;
    const tte = rawSlice[0].tte;
    const F = underlyingPrice * Math.exp(RISK_FREE * tte);

    // ── 关键修复：同 strike 有 call+put 两条，取 IV 均值后去重 ─────
    // 差分计算需要唯一 strike 序列，否则重复 strike 导致差分为零
    const strikeMap = new Map<number, number[]>();
    for (const p of rawSlice) {
      if (!strikeMap.has(p.strike)) strikeMap.set(p.strike, []);
      strikeMap.get(p.strike)!.push(p.impliedVol);
    }
    // 构造去重后的代理散点（用于差分计算）
    const dedupedSlice: IVSurfacePoint[] = [];
    for (const [strike, ivs] of strikeMap) {
      const avgIV = ivs.reduce((s, v) => s + v, 0) / ivs.length;
      dedupedSlice.push({ ...rawSlice.find(p => p.strike === strike)!, impliedVol: avgIV });
    }
    dedupedSlice.sort((a, b) => a.strike - b.strike);

    // 相邻切片也做去重（只用于时间方向差分）
    const dedupSlice = (sl: IVSurfacePoint[]): IVSurfacePoint[] => {
      const m = new Map<number, number[]>();
      for (const p of sl) {
        if (!m.has(p.strike)) m.set(p.strike, []);
        m.get(p.strike)!.push(p.impliedVol);
      }
      return [...m.entries()].map(([strike, ivs]) => ({
        ...sl.find(p => p.strike === strike)!,
        impliedVol: ivs.reduce((s, v) => s + v, 0) / ivs.length,
      }));
    };

    const prevSlice = ei > 0
      ? dedupSlice(byExpiry.get(sortedExpiries[ei - 1]) ?? []) : [];
    const nextSlice = ei < sortedExpiries.length - 1
      ? dedupSlice(byExpiry.get(sortedExpiries[ei + 1]) ?? []) : [];

    const params = sviParams[expiry] ?? null;
    const paramsNext = sortedExpiries[ei + 1] ? (sviParams[sortedExpiries[ei + 1]] ?? null) : null;
    const T2 = sortedExpiries[ei + 1] ? parseTTE(sortedExpiries[ei + 1]) : null;

    // 对去重后的每个 strike 计算
    for (const pt of dedupedSlice) {
      const K = pt.strike;
      const key = `${expiry}-${K}`;

      // 1. 散点有限差分 → impliedLocalVol
      const impliedLV = scatterPointLocalVol(pt, dedupedSlice, prevSlice, nextSlice, F);

      // 2. SVI 解析 → baselineLocalVol
      const baselineLV = params
        ? dupireLocalVol(K, F, tte, params, paramsNext, T2)
        : null;

      // 3. 相对残差
      // 基准 < 5% 时不可靠（近端极端虚值，分母趋零），跳过
      let relResidual: number | null = null;
      if (impliedLV !== null && baselineLV !== null && baselineLV > 0.05) {
        const rawRatio = (impliedLV - baselineLV) / baselineLV;
        // 相对残差限制在 [-2, 2] 内，防止极端值破坏归一化
        relResidual = Math.max(-2, Math.min(2, rawRatio));
      }

      lvByKey.set(key, { impliedLV, baselineLV, relResidual });
    }
  }

  // ── RBF 平滑：对所有有效的 impliedLV 做二维加权平均 ──────────────
  // 目的：消除有限差分引入的数值噪音，得到"平滑后的市场 LV 曲面"
  // 再用平滑 LV vs 基准 LV 的比值作为残差，避免单点差分噪音直接触发信号
  //
  // 坐标空间：(normK, normT)，分别归一化到 [0,1]，使两个维度权重均等
  // RBF 核：高斯核 exp(-d²/(2*bandwidth²))
  // bandwidth 经验值：0.25（覆盖约 25% 的坐标范围）

  // 收集所有有效的 impliedLV 散点（用于 RBF 拟合）
  interface LVScatter { normK: number; normT: number; impliedLV: number }
  const lvScatter: LVScatter[] = [];

  // 需要先知道 k 和 T 的范围才能归一化
  const allKeys = [...lvByKey.keys()];

  // 重建 (key → k, T) 映射
  const keyToKT = new Map<string, { k: number; T: number }>();
  for (let ei = 0; ei < sortedExpiries.length; ei++) {
    const expiry = sortedExpiries[ei];
    const rawSlice = byExpiry.get(expiry)!;
    const tte = rawSlice[0].tte;
    const F = underlyingPrice * Math.exp(RISK_FREE * tte);
    const strikeMap = new Map<number, number[]>();
    for (const p of rawSlice) {
      if (!strikeMap.has(p.strike)) strikeMap.set(p.strike, []);
      strikeMap.get(p.strike)!.push(p.impliedVol);
    }
    for (const [strike] of strikeMap) {
      const k = Math.log(strike / F);
      keyToKT.set(`${expiry}-${strike}`, { k, T: tte });
    }
  }

  // 收集散点
  for (const key of allKeys) {
    const lv = lvByKey.get(key)!;
    const kt = keyToKT.get(key);
    if (!kt || lv.impliedLV === null || !isFinite(lv.impliedLV)) continue;
    lvScatter.push({ normK: kt.k, normT: kt.T, impliedLV: lv.impliedLV });
  }

  // 归一化坐标
  const kVals = lvScatter.map(p => p.normK);
  const tVals = lvScatter.map(p => p.normT);
  const kMin = kVals.length ? Math.min(...kVals) : -1;
  const kMax = kVals.length ? Math.max(...kVals) : 1;
  const tMin = tVals.length ? Math.min(...tVals) : 0;
  const tMax = tVals.length ? Math.max(...tVals) : 1;
  const kRange = Math.max(kMax - kMin, 0.01);
  const tRange = Math.max(tMax - tMin, 0.001);

  const normalize = (k: number, T: number) => ({
    nk: (k - kMin) / kRange,
    nt: (T - tMin) / tRange,
  });

  // RBF 高斯核平滑（bandwidth = 0.25）
  const BW = 0.25;
  const rbfSmooth = (targetK: number, targetT: number): number | null => {
    if (lvScatter.length < 3) return null;
    const { nk: tnk, nt: tnt } = normalize(targetK, targetT);
    let sumW = 0;
    let sumWV = 0;
    for (const pt of lvScatter) {
      const { nk, nt } = normalize(pt.normK, pt.normT);
      const d2 = (tnk - nk) ** 2 + (tnt - nt) ** 2;
      const w = Math.exp(-d2 / (2 * BW * BW));
      sumW += w;
      sumWV += w * pt.impliedLV;
    }
    if (sumW < 1e-8) return null;
    return sumWV / sumW;
  };

  // ── 用平滑后的 LV vs 基准 LV 计算残差 ────────────────────────────
  // relResidual = (smoothedLV - baselineLV) / baselineLV
  // 这个残差已经消除了有限差分噪音，反映的是曲面结构性偏差
  interface LVFinal {
    impliedLV: number | null;
    smoothedLV: number | null;
    baselineLV: number | null;
    relResidual: number | null;
  }
  const lvFinalByKey = new Map<string, LVFinal>();

  for (const key of allKeys) {
    const raw = lvByKey.get(key)!;
    const kt = keyToKT.get(key);
    if (!kt) {
      lvFinalByKey.set(key, { ...raw, smoothedLV: null });
      continue;
    }

    const smoothedLV = rbfSmooth(kt.k, kt.T);
    let relResidual: number | null = null;
    if (smoothedLV !== null && raw.baselineLV !== null && raw.baselineLV > 0.05) {
      const rawRatio = (smoothedLV - raw.baselineLV) / raw.baselineLV;
      relResidual = Math.max(-2, Math.min(2, rawRatio));
    }

    lvFinalByKey.set(key, {
      impliedLV: raw.impliedLV,
      smoothedLV,
      baselineLV: raw.baselineLV,
      relResidual,
    });
  }

  // ── lvZScore：用绝对残差阈值，不再强制归一化 ─────────────────────
  // 逻辑：relResidual 本身就是有物理意义的量（相对偏差）
  // smoothedLV 比 baselineLV 偏高 > 20% → z = relResidual / 0.20（相对20%为1σ）
  // 这样 z ≥ 1.8 对应相对偏差 ≥ 36%，是真实的曲面凸起
  //
  // 同时保留全曲面 MAD 归一化作为参考，取两者较小值（保守）
  const allFinalResiduals = [...lvFinalByKey.values()]
    .map(v => v.relResidual)
    .filter((r): r is number => r !== null && isFinite(r));

  // MAD 归一化（鲁棒）
  let madCenter = 0;
  let madScale = 0.20; // 默认 20% 为 1σ
  if (allFinalResiduals.length >= 5) {
    const sorted = [...allFinalResiduals].sort((a, b) => a - b);
    madCenter = sorted[Math.floor(sorted.length / 2)];
    const absDev = allFinalResiduals.map(r => Math.abs(r - madCenter)).sort((a, b) => a - b);
    const mad = absDev[Math.floor(absDev.length / 2)];
    // 只有当 MAD 较大（曲面确实有结构性差异）时才用 MAD 缩放
    // 否则用固定 20% 基准，防止平坦曲面产生假高 z-score
    madScale = Math.max(mad * 1.4826, 0.15); // 最小 15%（避免过度敏感）
  }

  // 将结果反向映射回每一条原始记录（call 和 put 共享同 strike 的结果）
  return points.map(p => {
    const key = `${p.expiry}-${p.strike}`;
    const lv = lvFinalByKey.get(key);
    if (!lv) return p;

    const lvZScore = lv.relResidual !== null && isFinite(lv.relResidual)
      ? (lv.relResidual - madCenter) / madScale
      : undefined;

    return {
      ...p,
      localVol: lv.impliedLV ?? undefined,
      baselineLocalVol: lv.baselineLV ?? undefined,
      lvResidual: lv.relResidual ?? undefined,
      lvZScore,
    };
  });
}

// ─── 辅助：从 expiry 字符串计算 TTE ──────────────────────────────────
function parseTTE(expiry: string): number {
  const ms = new Date(expiry).getTime() - Date.now();
  return Math.max(ms / (365 * 24 * 3600 * 1000), 0);
}
