/**
 * SVI (Stochastic Volatility Inspired) 波动率曲面拟合
 *
 * 参数化形式（Raw SVI）：
 *   w(k) = a + b * [ rho*(k-m) + sqrt((k-m)^2 + sigma^2) ]
 *   其中 k = ln(K/F)，w = sigma_BS^2 * T（总方差）
 *   IV = sqrt(w / T)
 *
 * 无套利约束：
 *   b >= 0, |rho| < 1, sigma > 0, a + b*sigma*sqrt(1-rho^2) >= 0
 *
 * 拟合方法：Nelder-Mead 单纯形法 + 迭代重加权最小二乘（IRLS）
 *   → IRLS：对残差较大点自动降权，防止异常点扭曲曲面形状
 *
 * z-score 计算：residual / std(residuals)
 *   → SVI 经 IRLS 拟合后残差均值≈0，直接用 std 归一化最为标准
 *   → 与"隧道模型"σ 归一化方案一致：z_i = Residual_i / σ_residual
 */

import type { IVSurfacePoint, SVIParams } from '@/types';

// ─── SVI 核心函数 ─────────────────────────────────────────────────────

/** 给定 SVI 参数和对数价值度 k，返回总方差 w */
export function sviTotalVar(k: number, p: SVIParams): number {
  const { a, b, rho, m, sigma } = p;
  return a + b * (rho * (k - m) + Math.sqrt((k - m) ** 2 + sigma ** 2));
}

/** 总方差 → 隐含波动率（年化），上限 3.0（300%）防止爆炸值进入图表 */
export function sviIV(k: number, tte: number, p: SVIParams): number {
  const w = sviTotalVar(k, p);
  if (w <= 0 || tte <= 0) return 0;
  return Math.min(Math.sqrt(Math.max(w / tte, 0)), 3.0);
}

// ─── 无套利约束检查 ───────────────────────────────────────────────────
function isFeasible(p: SVIParams): boolean {
  const { a, b, rho, sigma } = p;
  return (
    b >= 0 &&
    Math.abs(rho) < 0.9999 &&
    sigma > 1e-6 &&
    a + b * sigma * Math.sqrt(1 - rho * rho) >= -1e-8
  );
}

// ─── Nelder-Mead 单纯形优化 ──────────────────────────────────────────
function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  maxIter = 3000,
  tol = 1e-10
): number[] {
  const n = x0.length;
  // 初始单纯形
  const simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += Math.abs(x0[i]) > 1e-8 ? 0.1 * x0[i] : 0.00025;
    simplex.push(v);
  }

  const vals = simplex.map(f);

  for (let iter = 0; iter < maxIter; iter++) {
    // 排序
    const idx = Array.from({ length: n + 1 }, (_, i) => i)
      .sort((a, b) => vals[a] - vals[b]);
    const best = simplex[idx[0]].slice();
    const worst = simplex[idx[n]];
    const secondWorst = simplex[idx[n - 1]];

    // 收敛检查
    const spread = vals[idx[n]] - vals[idx[0]];
    if (spread < tol) break;

    // 质心（排除最差点）
    const centroid = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[idx[i]][j];
    }
    centroid.forEach((_, j) => (centroid[j] /= n));

    // 反射
    const reflected = centroid.map((c, j) => c + 1.0 * (c - worst[j]));
    const fRefl = f(reflected);

    if (fRefl < vals[idx[0]]) {
      // 扩张
      const expanded = centroid.map((c, j) => c + 2.0 * (c - worst[j]));
      const fExp = f(expanded);
      if (fExp < fRefl) {
        simplex[idx[n]] = expanded;
        vals[idx[n]] = fExp;
      } else {
        simplex[idx[n]] = reflected;
        vals[idx[n]] = fRefl;
      }
    } else if (fRefl < vals[idx[n - 1]]) {
      simplex[idx[n]] = reflected;
      vals[idx[n]] = fRefl;
    } else {
      // 收缩
      const contracted = centroid.map((c, j) => c + 0.5 * (worst[j] - c));
      const fCont = f(contracted);
      if (fCont < vals[idx[n]]) {
        simplex[idx[n]] = contracted;
        vals[idx[n]] = fCont;
      } else {
        // 整体缩小
        for (let i = 1; i <= n; i++) {
          simplex[idx[i]] = simplex[idx[i]].map(
            (v, j) => best[j] + 0.5 * (v - best[j])
          );
          vals[idx[i]] = f(simplex[idx[i]]);
        }
      }
    }
  }

  const idx = Array.from({ length: n + 1 }, (_, i) => i)
    .sort((a, b) => vals[a] - vals[b]);
  return simplex[idx[0]];
}

// ─── 向量解码 ─────────────────────────────────────────────────────────
/** 将无约束向量映射为满足 SVI 约束的参数 */
function decode(v: number[]): SVIParams {
  return {
    a: v[0],
    b: Math.exp(v[1]),          // b > 0
    rho: Math.tanh(v[2]),        // |rho| < 1
    m: v[3],
    sigma: Math.exp(v[4]),       // sigma > 0
  };
}

function encode(p: SVIParams): number[] {
  return [
    p.a,
    Math.log(Math.max(p.b, 1e-6)),
    Math.atanh(Math.max(Math.min(p.rho, 0.9999), -0.9999)),
    p.m,
    Math.log(Math.max(p.sigma, 1e-6)),
  ];
}

// ─── Huber 权重（IRLS 迭代重加权）────────────────────────────────────
/**
 * Huber 损失对应的权重函数：残差小时权重=1，大时按 δ/|r| 降权
 * 让拟合曲面贴近"多数点"，自动忽略真正的异常点
 * δ 取残差的 MAD 的 1.5 倍（自适应），越小越激进地降权
 */
function huberWeights(residuals: number[], deltaScale = 1.5): number[] {
  const absRes = residuals.map(Math.abs);
  const sorted = [...absRes].sort((a, b) => a - b);
  const mad = sorted[Math.floor(sorted.length / 2)] * 1.4826; // MAD → 等价标准差
  const delta = Math.max(mad * deltaScale, 1e-6);
  return absRes.map(r => (r <= delta ? 1.0 : delta / r));
}

// ─── 单切片拟合 ──────────────────────────────────────────────────────
/**
 * 对一个到期日的 IV 切片拟合 SVI
 * 改进：IRLS（迭代重加权），异常点自动降权，曲面更光滑
 * @param points 该到期日的所有期权点
 * @returns SVIParams 或 null（数据不足）
 */
export function fitSVISlice(
  points: { k: number; tte: number; iv: number; weight?: number }[]
): SVIParams | null {
  // 动态上限：根据输入数据的实际 IV 范围自适应，最高允许 300%
  // 同时过滤极度虚值（|k| > 2.5），这些点 IV 天然失真
  const ivUpperBound = Math.min(Math.max(...points.map(p => p.iv)) * 1.5, 3.0);
  const validPts = points.filter(p =>
    p.iv > 0.01 && p.iv < ivUpperBound && p.tte > 1e-6 && Math.abs(p.k) < 2.5
  );
  if (validPts.length < 3) return null;

  const tte = validPts[0].tte;

  // ── 数据驱动的初始参数估计 ────────────────────────────────────────
  const kArr = validPts.map(p => p.k);
  const ivArr = validPts.map(p => p.iv);
  const kMin = Math.min(...kArr), kMax = Math.max(...kArr);

  // 找最近 ATM 点
  const atmIdx = kArr.reduce((best, k, i) =>
    Math.abs(k) < Math.abs(kArr[best]) ? i : best, 0);
  const atmVar = ivArr[atmIdx] ** 2 * tte;

  // 从散点估算 skew 方向：比较 k<0 和 k>0 两侧平均 IV
  const leftIVs = validPts.filter(p => p.k < -0.05).map(p => p.iv);
  const rightIVs = validPts.filter(p => p.k > 0.05).map(p => p.iv);
  const leftMean = leftIVs.length ? leftIVs.reduce((s, v) => s + v, 0) / leftIVs.length : ivArr[atmIdx];
  const rightMean = rightIVs.length ? rightIVs.reduce((s, v) => s + v, 0) / rightIVs.length : ivArr[atmIdx];
  const dataRho = leftMean > rightMean ? -0.4 : 0.4;

  // smile 宽度估计：取 k 范围
  const kSpan = Math.max(kMax - kMin, 0.2);

  const init: SVIParams = {
    a: atmVar * 0.8,
    b: Math.max(atmVar / Math.max(kSpan, 0.3), 0.05),
    rho: dataRho,
    m: 0,
    sigma: kSpan * 0.4,
  };

  // 多起点：覆盖 rho 正负两方向 + 不同 b/sigma 组合
  const startPoints: SVIParams[] = [
    init,
    { ...init, rho: -dataRho },
    { ...init, b: init.b * 0.5, sigma: init.sigma * 0.5 },
    { ...init, b: init.b * 2,   sigma: init.sigma * 2   },
    { a: atmVar * 0.5, b: 0.15, rho: -0.5, m: 0, sigma: 0.3 },
    { a: atmVar * 0.9, b: 0.05, rho:  0.1, m: 0, sigma: 0.5 },
  ];

  let bestParams = init;
  let bestVal = Infinity;

  // ── IRLS：先做初始拟合，再迭代重加权 2 轮 ──────────────────────────
  for (const sp of startPoints) {
    // 第一轮：等权
    let currentWeights = validPts.map(p => p.weight ?? 1);

    const makeObjective = (wts: number[]) => (v: number[]): number => {
      const p = decode(v);
      if (!isFeasible(p)) return 1e10;
      let mse = 0;
      for (let i = 0; i < validPts.length; i++) {
        const pt = validPts[i];
        const wMkt = pt.iv * pt.iv * tte;
        const wFit = sviTotalVar(pt.k, p);
        // ATM 附近高斯权重 * IRLS Huber 权重
        const atmW = Math.exp(-0.5 * pt.k * pt.k);
        mse += wts[i] * atmW * (wFit - wMkt) ** 2;
      }
      return mse / validPts.length;
    };

    const v0 = encode(sp);
    const r1 = nelderMead(makeObjective(currentWeights), v0);
    let params1 = decode(r1);

    // 第二轮：用第一轮残差计算 Huber 权重
    if (isFeasible(params1)) {
      const residuals1 = validPts.map(pt => {
        const wMkt = pt.iv * pt.iv * tte;
        const wFit = sviTotalVar(pt.k, params1);
        return wFit - wMkt;
      });
      const irls1 = huberWeights(residuals1, 1.5);
      const combinedW1 = validPts.map((p, i) => (p.weight ?? 1) * irls1[i]);
      const r2 = nelderMead(makeObjective(combinedW1), encode(params1));
      const params2 = decode(r2);

      // 第三轮（最终）：再用一次 Huber 权重
      if (isFeasible(params2)) {
        const residuals2 = validPts.map(pt => {
          const wMkt = pt.iv * pt.iv * tte;
          const wFit = sviTotalVar(pt.k, params2);
          return wFit - wMkt;
        });
        const irls2 = huberWeights(residuals2, 1.2); // 收紧到 1.2σ
        const combinedW2 = validPts.map((p, i) => (p.weight ?? 1) * irls2[i]);
        const r3 = nelderMead(makeObjective(combinedW2), encode(params2));
        params1 = decode(r3);
      } else {
        params1 = params2.b >= 0 ? params2 : params1;
      }
    }

    const val = makeObjective(currentWeights)(encode(params1));
    if (val < bestVal && isFeasible(params1)) {
      bestVal = val;
      bestParams = params1;
    }
  }

  if (!isFeasible(bestParams)) return null;

  // ── 后验验证 ─────────────────────────────────────────────────────
  const kArr2 = validPts.map(p => p.k);
  const kLo2 = Math.min(...kArr2);
  const kHi2 = Math.max(...kArr2);
  const inputMaxIV = Math.max(...validPts.map(p => p.iv));
  const ivCap = Math.max(inputMaxIV * 3, 0.8);
  const checkKs = Array.from({ length: 21 }, (_, i) => kLo2 + (i / 20) * (kHi2 - kLo2));

  // 1. IV 爆炸检查
  const hasBoom = checkKs.some(k => sviIV(k, validPts[0].tte, bestParams) > ivCap);
  if (hasBoom) return null;

  // 2. 无蝶式套利：Breeden-Litzenberger 密度 g(k) ≥ 0
  //    g(k) = (1 - k*w'/(2w))² - w'²/4*(1/w + 1/4) + w''/2
  //    w'(k)  = b * [rho + (k-m)/sqrt((k-m)²+sigma²)]
  //    w''(k) = b * sigma² / ((k-m)²+sigma²)^(3/2)
  const { b, rho, m, sigma } = bestParams;
  const hasNegDensity = checkKs.some(k => {
    const xi = k - m;
    const disc = Math.sqrt(xi * xi + sigma * sigma);
    const w   = sviTotalVar(k, bestParams);
    if (w <= 0) return true;
    const wp  = b * (rho + xi / disc);              // w'
    const wpp = b * sigma * sigma / (disc * disc * disc); // w''
    const g   = (1 - k * wp / (2 * w)) ** 2
              - wp * wp / 4 * (1 / w + 0.25)
              + wpp / 2;
    return g < -1e-6; // 允许极小的数值误差
  });
  if (hasNegDensity) return null;

  return bestParams;
}

// ─── 全曲面拟合 & 残差计算 ────────────────────────────────────────────
/**
 * 对所有期权点按到期日分组拟合 SVI，返回带 fittedVol / residual / zScore 的点
 *
 * z-score：residual / std(residuals)
 *   SVI 经 IRLS 拟合后大残差点已被降权，残差分布均值≈0
 *   直接用 std 作分母是最标准的归一化方式：z_i = residual_i / σ_residual
 *   与隧道模型的 σ 归一化方案完全一致，阈值（±1.5/±2.0/±2.8）含义一致
 */
export function fitSurface(
  points: IVSurfacePoint[]
): { fittedPoints: IVSurfacePoint[]; sviParams: Record<string, SVIParams> } {
  // 按到期日分组
  const byExpiry = new Map<string, IVSurfacePoint[]>();
  for (const p of points) {
    if (!byExpiry.has(p.expiry)) byExpiry.set(p.expiry, []);
    byExpiry.get(p.expiry)!.push(p);
  }

  const sviParams: Record<string, SVIParams> = {};
  const fittedPoints: IVSurfacePoint[] = [];

  for (const [expiry, slicePoints] of byExpiry) {
    const fitInput = slicePoints.map(p => {
      const k = p.moneyness * Math.sqrt(p.tte);
      // 等权传入：目标函数内部已有 atmW = exp(-0.5k²)，不重复叠加
      return { k, tte: p.tte, iv: p.impliedVol, weight: 1 };
    });

    const params = fitSVISlice(fitInput);

    if (!params) {
      fittedPoints.push(...slicePoints);
      continue;
    }

    // 存入 tte，供前端生成曲面网格
    const sliceTte = slicePoints[0]?.tte ?? 0;
    sviParams[expiry] = { ...params, tte: sliceTte };

    // 计算残差
    const residuals: number[] = [];
    const fitted = slicePoints.map(p => {
      const k = p.moneyness * Math.sqrt(p.tte);
      const fv = sviIV(k, p.tte, params);
      const residual = p.impliedVol - fv;
      residuals.push(residual);
      return { ...p, fittedVol: fv, residual };
    });

    // ── σ 归一化 z-score ──────────────────────────────────────────
    // residual / std(residuals)：SVI IRLS 拟合后均值≈0，std 归一化最标准
    // σ 地板设 1e-6，防止市场极度平静时阈值过于敏感
    const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
    const variance = residuals.reduce((s, r) => s + (r - mean) ** 2, 0) / residuals.length;
    const stdRes = Math.max(Math.sqrt(variance), 1e-6);

    fitted.forEach(p => {
      fittedPoints.push({
        ...p,
        zScore: p.residual! / stdRes,
      });
    });
  }

  // ── 日历套利检查：对已拟合的相邻切片验证 w(k,T₂) ≥ w(k,T₁) ──────
  // 若违反则丢弃远月切片参数（保守策略：宁可少一个切片也不留逆序）
  const sortedExpiries = [...byExpiry.keys()].sort();
  for (let i = 0; i + 1 < sortedExpiries.length; i++) {
    const expNear = sortedExpiries[i];
    const expFar  = sortedExpiries[i + 1];
    const pNear = sviParams[expNear];
    const pFar  = sviParams[expFar];
    if (!pNear || !pFar) continue;

    // 在两个切片的 k 并集上均匀检查 20 个点
    const nearPts = byExpiry.get(expNear)!.map(p => p.moneyness * Math.sqrt(p.tte));
    const farPts  = byExpiry.get(expFar)!.map(p => p.moneyness * Math.sqrt(p.tte));
    const kLo = Math.max(Math.min(...nearPts), Math.min(...farPts));
    const kHi = Math.min(Math.max(...nearPts), Math.max(...farPts));
    if (kLo >= kHi) continue;

    const hasCalendarViolation = Array.from({ length: 20 }, (_, j) =>
      kLo + (j / 19) * (kHi - kLo)
    ).some(k => sviTotalVar(k, pFar) < sviTotalVar(k, pNear) - 1e-6);

    if (hasCalendarViolation) {
      // 丢弃违反的远月参数，该切片退化为无SVI
      delete sviParams[expFar];
    }
  }

  return { fittedPoints, sviParams };
}

// ─── 切片统计 ─────────────────────────────────────────────────────────
export function computeSliceStats(
  points: IVSurfacePoint[],
  tte: number,
  expiry: string,
  params: SVIParams | null
) {
  const sorted = [...points].sort((a, b) => a.moneyness - b.moneyness);
  const atm = sorted.reduce((best, p) =>
    Math.abs(p.moneyness) < Math.abs(best.moneyness) ? p : best
  );

  // 25-delta 近似：moneyness ≈ ±0.5*IV*sqrt(T) ≈ ±0.4
  const delta25k = 0.4;
  const upper = sorted.filter(p => p.moneyness > delta25k);
  const lower = sorted.filter(p => p.moneyness < -delta25k);
  const callVol = upper.length ? upper[0].impliedVol : atm.impliedVol;
  const putVol = lower.length ? lower[lower.length - 1].impliedVol : atm.impliedVol;
  const skew = putVol - callVol;
  const butterfly = (callVol + putVol) / 2 - atm.impliedVol;

  const rmse = params
    ? Math.sqrt(
      points.reduce((s, p) => s + (p.residual ?? 0) ** 2, 0) / points.length
    )
    : 0;

  return {
    expiry,
    tte,
    atmVol: atm.impliedVol,
    skew,
    kurtosis: butterfly,
    rmse,
  };
}
