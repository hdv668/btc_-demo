import { NextRequest, NextResponse } from 'next/server';
import { fetchBTCOptions } from '@/lib/data/fetcher';

// ─────────────────────────────────────────────
//  1. Black-Scholes 正向定价 (The Forward Model)
//  C(S,K,T,r,σ) = S·N(d1) - K·e^{-rT}·N(d2)
//  d1 = [ln(S/K) + (r + σ²/2)·T] / (σ√T)
//  d2 = d1 - σ√T
// ─────────────────────────────────────────────
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x >= 0 ? 1 - p : p;
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsCallPrice(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

// ─────────────────────────────────────────────
//  2. Vega = ∂C/∂σ = S·√T·N'(d1)
// ─────────────────────────────────────────────
function bsVega(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normPdf(d1);
}

// ─────────────────────────────────────────────
//  二分法 IV 求解（Newton-Raphson 退化时备用）
// ─────────────────────────────────────────────
function ivBisection(
  S: number, K: number, T: number, r: number, marketPrice: number,
  low = 0.001, high = 5.0, tol = 1e-6, maxIter = 100
): number {
  for (let i = 0; i < maxIter; i++) {
    const mid = (low + high) / 2;
    const price = bsCallPrice(S, K, T, r, mid);
    if (Math.abs(price - marketPrice) < tol) return mid;
    if (price < marketPrice) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

// ─────────────────────────────────────────────
//  3. Newton-Raphson 隐含波动率反解
// ─────────────────────────────────────────────
function impliedVolatility(
  S: number, K: number, T: number, r: number, marketPrice: number
): number | null {
  const intrinsic = Math.max(S - K, 0);
  if (marketPrice < intrinsic - 0.01 || marketPrice <= 0) return null;

  let sigma = 0.5;
  for (let i = 0; i < 100; i++) {
    const price = bsCallPrice(S, K, T, r, sigma);
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-6) return sigma;
    const vega = bsVega(S, K, T, r, sigma);
    if (vega < 1e-8) return ivBisection(S, K, T, r, marketPrice);
    sigma = sigma - diff / vega;
    if (sigma <= 0 || sigma > 5.0) return ivBisection(S, K, T, r, marketPrice);
  }
  return ivBisection(S, K, T, r, marketPrice);
}

// ─────────────────────────────────────────────
//  4. 正则化 RBF Cubic 插值（Regularized Tikhonov）
//
//  标准 RBF：Φ·w = z，曲面严格穿过每个点（插值）
//  正则化 RBF：(Φ + λ·I)·w = z，引入 L2 惩罚项
//
//  数学含义：
//    λ = 0   → 完全插值（每个点都在曲面上）
//    λ = 0.01 → 弱平滑（微小偏离允许）
//    λ = 0.1  → 中等平滑（异常点明显脱离曲面，适合异常检测）
//    λ = 0.5  → 强平滑（曲面接近全局趋势）
//
//  异常检测原理：
//    加入正则项后，曲面不再被单个异常点"拉偏"。
//    真正的异常点（偏离市场整体结构）的残差 ε 会更大，
//    从而"悬浮"于曲面之上，更容易被 σ 阈值捕获。
// ─────────────────────────────────────────────
function rbfCubicInterpolate(
  srcX: number[], srcY: number[], srcZ: number[],
  qX: number[], qY: number[],
  lambda = 0.0   // 正则化强度（Tikhonov 平滑因子）
): number[] {
  const n = srcX.length;
  const xMin = Math.min(...srcX), xMax = Math.max(...srcX);
  const yMin = Math.min(...srcY), yMax = Math.max(...srcY);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const nx = srcX.map(v => (v - xMin) / xRange);
  const ny = srcY.map(v => (v - yMin) / yRange);

  // 构建 (Φ + λI)·w = z
  // 对角线 Phi[i][i] 增加 λ，等价于：
  //   minimize || Φw - z ||² + λ || w ||²
  const Phi: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = nx[i] - nx[j], dy = ny[i] - ny[j];
      const r = Math.sqrt(dx * dx + dy * dy);
      Phi[i][j] = r * r * r;
    }
    // Tikhonov 正则化：对角线加 λ
    Phi[i][i] += lambda;
  }

  // 高斯消元（带部分主元）
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

  const nqx = qX.map(v => (v - xMin) / xRange);
  const nqy = qY.map(v => (v - yMin) / yRange);
  return nqx.map((qx, qi) => {
    const qy = nqy[qi];
    let val = 0;
    for (let i = 0; i < n; i++) {
      const dx = qx - nx[i], dy = qy - ny[i];
      const r = Math.sqrt(dx * dx + dy * dy);
      val += w[i] * r * r * r;
    }
    return val;
  });
}

// ─────────────────────────────────────────────
//  5. SVI 拟合（Stochastic Volatility Inspired）
//
//  SVI 参数化总方差：
//    w(k) = a + b * [ ρ(k-m) + sqrt((k-m)²+σ²) ]
//  IV(k,T) = sqrt(w(k)/T)
//
//  k = ln(K/F) = log-moneyness
//  使用 Nelder-Mead 极简实现（不引入外部优化库）
// ─────────────────────────────────────────────

/** SVI 总方差 */
function sviW(k: number, a: number, b: number, rho: number, m: number, sig: number): number {
  return a + b * (rho * (k - m) + Math.sqrt((k - m) * (k - m) + sig * sig));
}

/** SVI → IV（小数），tte=年化到期时间 */
function sviIV(k: number, tte: number, a: number, b: number, rho: number, m: number, sig: number): number | null {
  const w = sviW(k, a, b, rho, m, sig);
  if (w <= 0 || tte <= 0) return null;
  return Math.sqrt(w / tte);
}

/**
 * Nelder-Mead 极简实现（5维）
 * 用于在给定到期日切片的散点 [k_i, iv_i] 上拟合 SVI 参数
 */
function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  maxIter = 2000,
  tol = 1e-8
): number[] {
  const n = x0.length;
  const alpha = 1.0, beta = 0.5, gamma = 2.0, delta = 0.5;

  // 初始化单纯形（n+1 个顶点）
  let simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += Math.abs(v[i]) > 1e-6 ? v[i] * 0.05 + 1e-4 : 0.05;
    simplex.push(v);
  }

  let fVals = simplex.map(f);

  for (let iter = 0; iter < maxIter; iter++) {
    // 排序
    const idx = Array.from({ length: n + 1 }, (_, i) => i).sort((a, b) => fVals[a] - fVals[b]);
    simplex = idx.map(i => simplex[i]);
    fVals = idx.map(i => fVals[i]);

    // 收敛检测
    const range = fVals[n] - fVals[0];
    if (range < tol) break;

    // 重心（排除最差点）
    const centroid = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;

    // 反射
    const xr = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = f(xr);

    if (fr < fVals[0]) {
      // 扩展
      const xe = centroid.map((c, j) => c + gamma * (xr[j] - c));
      const fe = f(xe);
      simplex[n] = fe < fr ? xe : xr;
      fVals[n] = fe < fr ? fe : fr;
    } else if (fr < fVals[n - 1]) {
      simplex[n] = xr;
      fVals[n] = fr;
    } else {
      // 收缩
      const xc = centroid.map((c, j) => c + beta * (simplex[n][j] - c));
      const fc = f(xc);
      if (fc < fVals[n]) {
        simplex[n] = xc;
        fVals[n] = fc;
      } else {
        // 收缩全部
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + delta * (v - simplex[0][j]));
          fVals[i] = f(simplex[i]);
        }
      }
    }
  }
  return simplex[0];
}

interface SVIFitResult {
  a: number; b: number; rho: number; m: number; sigma: number;
  tte: number;
  rmse: number;
}

/**
 * 对一个到期日切片的散点 (k[], iv[]) 拟合 SVI 参数
 * 约束：a>-0.5·w_atm, b>0, |ρ|<1, σ>0, a+b·σ·sqrt(1-ρ²)>=0
 */
function fitSVI(ks: number[], ivs: number[], tte: number): SVIFitResult | null {
  if (ks.length < 5) return null;

  // 以总方差 w = iv² * tte 拟合，更稳定
  const ws = ivs.map(iv => iv * iv * tte);

  // 目标函数：RMSE(w)
  const objective = ([a, b, rho, m, sig]: number[]): number => {
    // 硬约束：映射到可行域
    const bC   = Math.max(b, 1e-6);
    const rhoC = Math.max(-0.9999, Math.min(0.9999, rho));
    const sigC = Math.max(sig, 1e-6);
    // 蝶式套利约束：a + b*sigC*sqrt(1-rhoC²) >= 0
    const minA = -bC * sigC * Math.sqrt(1 - rhoC * rhoC);
    const aC = Math.max(a, minA + 1e-8);

    let sse = 0;
    for (let i = 0; i < ks.length; i++) {
      const w_fit = sviW(ks[i], aC, bC, rhoC, m, sigC);
      const diff = w_fit - ws[i];
      sse += diff * diff;
    }
    return sse / ks.length;
  };

  // 初始猜测：ATM vol 附近
  const atmIV = ivs.reduce((s, v) => s + v, 0) / ivs.length;
  const atmW  = atmIV * atmIV * tte;
  const x0 = [atmW * 0.5, 0.1, -0.3, 0.0, 0.2];

  const result = nelderMead(objective, x0);
  const [a, b, rho, m, sig] = result;
  const bC   = Math.max(b, 1e-6);
  const rhoC = Math.max(-0.9999, Math.min(0.9999, rho));
  const sigC = Math.max(sig, 1e-6);
  const minA = -bC * sigC * Math.sqrt(1 - rhoC * rhoC);
  const aC = Math.max(a, minA + 1e-8);

  // RMSE(IV %)
  let sse = 0;
  for (let i = 0; i < ks.length; i++) {
    const iv_fit = sviIV(ks[i], tte, aC, bC, rhoC, m, sigC);
    if (iv_fit === null) continue;
    sse += (iv_fit - ivs[i]) ** 2;
  }
  const rmse = Math.sqrt(sse / ks.length);

  return { a: aC, b: bC, rho: rhoC, m, sigma: sigC, tte, rmse };
}

// ─────────────────────────────────────────────
//  6. RND（Risk-Neutral Density）计算
//
//  Breeden-Litzenberger（1978）：
//    q(K) = e^{rT} · ∂²C/∂K²
//
//  通过 SVI → BS Call 价格 C(K)，对 K 求解析二阶导：
//    ∂C/∂K = e^{-rT}·[-N(d2)]       (Delta 关于 K 的导数)
//    ∂²C/∂K² = e^{-rT} · N'(d2) / (K·σ_loc·√T)
//
//  因此 q(K) = N'(d2) / (K·σ_IV·√T)
//  （r=0 时 F=S，σ_loc = σ_IV(K,T)，公式进一步简化）
//
//  对每个到期日，沿 K 轴均匀采样 200 个点，输出 {K, tte, density}
// ─────────────────────────────────────────────

export interface RNDPoint {
  strike: number;      // 行权价 K（USD）
  logMoneyness: number; // k = ln(K/F)
  tte: number;
  expiry: string;
  density: number;     // 风险中性概率密度 q(K)（已归一化为概率密度，非概率）
  cdf: number;         // 累积分布函数 Q(K) = P(S_T < K)
  iv: number;          // 该点对应的 SVI IV（%）
}

/**
 * 对一个切片（固定 tte），用 SVI 参数解析计算 Breeden-Litzenberger 密度
 * q(K) = e^{rT} · ∂²C/∂K²
 *
 * C(K) = F·e^{-rT}·N(d1) - K·e^{-rT}·N(d2)
 *   d1 = [-k + σ(k,T)²T/2] / (σ(k,T)√T)   （k=ln(K/F)，F=S·e^{rT}，r=0时F=S）
 *   d2 = d1 - σ(k,T)·√T
 *
 * ∂²C/∂K²：用数值微分（步长 h=K*0.001）保证稳定性
 */
function computeRNDSlice(
  params: SVIFitResult,
  S: number,
  r: number,
  nPoints = 200
): Omit<RNDPoint, 'expiry'>[] {
  const { a, b, rho, m, sigma: sig, tte } = params;
  const F = S * Math.exp(r * tte);

  // k 范围：±2（约 ln(K/S) ∈ [-2, 2]，覆盖 S·e^{-2} ~ S·e^{+2}）
  const kMin = -1.8, kMax = 1.8;
  const kArr = Array.from({ length: nPoints }, (_, i) => kMin + (i / (nPoints - 1)) * (kMax - kMin));

  // BS Call 价格，使用 SVI IV（r=0 简化）
  const callPrice = (K: number): number => {
    const k = Math.log(K / F);
    const iv = sviIV(k, tte, a, b, rho, m, sig);
    if (!iv || iv <= 0) return Math.max(F - K, 0);
    const sqT = Math.sqrt(tte);
    const d1 = (-k + 0.5 * iv * iv * tte) / (iv * sqT);
    const d2 = d1 - iv * sqT;
    return Math.exp(-r * tte) * (F * normCdf(d1) - K * normCdf(d2));
  };

  // 二阶导数（数值微分，步长 h = 0.1% * K，足够精确且稳定）
  const result: Omit<RNDPoint, 'expiry'>[] = [];
  for (let i = 0; i < nPoints; i++) {
    const k = kArr[i];
    const K = F * Math.exp(k);

    const h = K * 0.001;
    const cUp = callPrice(K + h);
    const cMid = callPrice(K);
    const cDn = callPrice(K - h);
    const d2C_dK2 = (cUp - 2 * cMid + cDn) / (h * h);

    // Breeden-Litzenberger：q(K) = e^{rT} · ∂²C/∂K²
    const density = Math.max(d2C_dK2 * Math.exp(r * tte), 0);

    const iv = sviIV(k, tte, a, b, rho, m, sig) ?? 0;
    result.push({ strike: K, logMoneyness: k, tte, density, cdf: 0, iv: iv * 100 });
  }

  // 梯形积分归一化 + 累积
  const dK = result[1].strike - result[0].strike;
  let total = 0;
  for (let i = 0; i < result.length - 1; i++) {
    total += 0.5 * (result[i].density + result[i + 1].density) * (result[i + 1].strike - result[i].strike);
  }
  if (total > 1e-10) {
    for (const p of result) p.density /= total; // 归一化为概率密度
  }

  // 累积分布
  let cumulative = 0;
  for (let i = 0; i < result.length; i++) {
    if (i > 0) {
      cumulative += 0.5 * (result[i - 1].density + result[i].density) * (result[i].strike - result[i - 1].strike);
    }
    result[i].cdf = Math.min(cumulative, 1);
  }

  return result;
}

// ─────────────────────────────────────────────
//  7. 胜率计算（Probability of IV Mean Reversion）
//
//  Z-Score = ε / σ_residual
//  P(回归) = normCdf(|Z| - 1)
//  偏离 2σ 时 P ≈ normCdf(1) ≈ 84%
//  偏离 3σ 时 P ≈ normCdf(2) ≈ 97.7%
// ─────────────────────────────────────────────
function calcWinProb(residual: number, sigma: number): number {
  const z = Math.abs(residual) / (sigma || 1e-9);
  const p = normCdf(z - 1.0);
  return Math.min(Math.max(p, 0.5), 0.99);
}

// ─────────────────────────────────────────────
//  6. 盈亏预测（Expected Profit / Loss via BS）
// ─────────────────────────────────────────────
function calcPnL(
  S: number, K: number, T: number, r: number,
  ivMarket: number, ivSurface: number, sigma: number,
  anomalyType: 'overpriced' | 'underpriced'
): {
  currentPrice: number;
  targetPrice: number;
  shockPrice: number;
  expectedProfit: number;
  expectedLoss: number;
} {
  const cMarket = bsCallPrice(S, K, T, r, ivMarket);
  const cTarget = bsCallPrice(S, K, T, r, ivSurface);

  const ivShock = anomalyType === 'overpriced'
    ? ivMarket + sigma
    : ivMarket - sigma;
  const cShock = bsCallPrice(S, K, T, r, Math.max(ivShock, 0.01));

  let expectedProfit: number;
  let expectedLoss: number;

  if (anomalyType === 'overpriced') {
    expectedProfit = Math.max(cMarket - cTarget, 0);
    expectedLoss = Math.max(cShock - cMarket, 0);
  } else {
    expectedProfit = Math.max(cTarget - cMarket, 0);
    expectedLoss = Math.max(cMarket - cShock, 0);
  }

  return { currentPrice: cMarket, targetPrice: cTarget, shockPrice: cShock, expectedProfit, expectedLoss };
}


// ─────────────────────────────────────────────
//  数据结构定义
// ─────────────────────────────────────────────
export interface TradeAnalysis {
  winProb: number;
  currentPrice: number;
  targetPrice: number;
  shockPrice: number;
  expectedProfit: number;
  expectedLoss: number;
  ev: number;
  takeProfitIV: number;
  stopLossIV: number;
}

export interface IVPoint {
  strike: number;
  tenor: number;
  iv: number;
  ivBid: number;
  ivAsk: number;
  ivSurface: number;
  residual: number;
  anomalyType: 'overpriced' | 'underpriced' | 'normal';
  expiry: string;
  instrument: string;
  bidPrice: number;
  askPrice: number;
  spreadPct: number;
  underlyingPrice: number;
  // 压力测试：该点是否被人工注入了扰动
  stressInjected?: boolean;
  stressAmt?: number;   // 注入的 IV 扰动量（小数），正=高估扰动，负=低估扰动
  tradeAnalysis?: TradeAnalysis;
}

export interface SVIParams {
  a: number; b: number; rho: number; m: number; sigma: number;
  tte: number; rmse: number;
}

export interface SurfaceResponse {
  points: IVPoint[];
  underlyingPrice: number;
  fetchedAt: string;
  count: number;
  overpricedCount: number;
  underpricedCount: number;
  sigmaThreshold: number;
  residualSigma: number;
  // SVI 拟合参数（按到期日 key）
  sviParams: Record<string, SVIParams>;
  // RND 切片（按到期日 key）
  rndSlices: Record<string, RNDPoint[]>;
  // 当前参数
  params: {
    sigmaMultiplier: number;  // 用户设定的 σ 倍数（0.5–3.0）
    absPctThreshold: number;  // 绝对百分比阈值（0–1，小数）
    smoothLambda: number;     // RBF 正则化强度
    stressMode: boolean;      // 是否为压力测试模式
    stressCount: number;      // 注入扰动的合约数
  };
}

export async function GET(req: NextRequest) {
  try {
    // ── 解析查询参数 ──
    const sp = req.nextUrl.searchParams;

    // 灵敏度：σ 倍数，默认 2.0，范围 0.5–3.0
    const sigmaMultiplier = Math.min(3.0, Math.max(0.5, parseFloat(sp.get('sigma') ?? '2.0')));

    // 绝对百分比阈值（如 0.10 = 10%）；0 = 不启用
    const absPctThreshold = Math.min(1.0, Math.max(0.0, parseFloat(sp.get('absPct') ?? '0.10')));

    // RBF 正则化强度，默认 0.05（弱平滑）；0 = 完全插值
    const smoothLambda = Math.min(1.0, Math.max(0.0, parseFloat(sp.get('smooth') ?? '0.05')));

    // 压力测试模式：随机给 N 个合约注入 ±20% IV 扰动
    const stressMode = sp.get('stress') === '1';
    const stressCount = Math.min(10, Math.max(1, parseInt(sp.get('stressCount') ?? '5')));

    // 使用健壮的 fetcher 层（已包含回退机制）
    const snapshot = await fetchBTCOptions();
    const windowTs = snapshot.fetchedAt;
    const underlying = snapshot.underlyingPrice;
    const r = 0.0;

    interface RawPoint {
      instrument: string;
      strike: number;
      tenor: number;
      iv: number;
      ivBid: number;
      ivAsk: number;
      bidPrice: number;
      askPrice: number;
      expiry: string;
      spreadPct: number;
      S: number;
    }

    // 转换数据格式
    const rawPoints: RawPoint[] = snapshot.contracts
      .filter(c => c.optionType === 'call') // 只保留看涨期权，与原代码一致
      .map(c => {
        // 从合约构造 instrument_name（用于兼容）
        const expiryParts = c.expiry.split('-');
        const yy = expiryParts[0].slice(2);
        const mmNum = parseInt(expiryParts[1]);
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const mm = months[mmNum - 1];
        const dd = expiryParts[2];
        const instrumentName = `BTC-${dd}${mm}${yy}-${Math.round(c.strike)}-C`;

        // 估算 BTC 计价的 bid/ask（原代码需要）
        const bidPriceBtc = c.bid / c.underlyingPrice;
        const askPriceBtc = c.ask / c.underlyingPrice;

        return {
          instrument: instrumentName,
          strike: c.strike,
          tenor: c.tte,
          iv: c.impliedVol,
          ivBid: c.impliedVol * 0.98, // 模拟 bid IV
          ivAsk: c.impliedVol * 1.02, // 模拟 ask IV
          bidPrice: bidPriceBtc,
          askPrice: askPriceBtc,
          expiry: `${dd}${mm}${yy}`,
          spreadPct: (c.ask - c.bid) / ((c.bid + c.ask) / 2),
          S: c.underlyingPrice,
        };
      });

    if (rawPoints.length < 6) {
      return NextResponse.json({ error: '有效期权数据不足，无法构建曲面' }, { status: 422 });
    }

    // ── 压力测试：随机选 stressCount 个合约注入 ±20% IV 扰动 ──
    // 扰动记录：保留原始 iv，修改 iv/ivBid/ivAsk
    const stressMap = new Map<string, number>(); // instrument -> 扰动量（小数）

    if (stressMode) {
      // 使用确定性伪随机（基于时间戳种子），同一次请求结果一致
      const seed = Math.floor(windowTs / 60000); // 分钟级固定种子
      const lcg = (s: number) => (s * 1664525 + 1013904223) & 0xffffffff;

      let rng = seed;
      // 随机打乱并取前 stressCount 个
      const indices = rawPoints.map((_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        rng = lcg(rng);
        const j = Math.abs(rng) % (i + 1);
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const stressIndices = indices.slice(0, stressCount);

      for (const idx of stressIndices) {
        rng = lcg(rng);
        // ±20% IV 扰动，正负随机
        const direction = Math.abs(rng) % 2 === 0 ? 1 : -1;
        const amt = direction * 0.20; // 20% 扰动

        stressMap.set(rawPoints[idx].instrument, amt);

        // 修改该合约的 IV（确保不低于 0.05）
        rawPoints[idx].iv = Math.max(rawPoints[idx].iv + amt, 0.05);
        rawPoints[idx].ivBid = Math.max(rawPoints[idx].ivBid + amt, 0.05);
        rawPoints[idx].ivAsk = Math.max(rawPoints[idx].ivAsk + amt, 0.05);
      }
    }

    // ── Step 2：构建正则化 RBF 基准曲面 ──
    // smoothLambda 越大，曲面越平滑，异常点的残差越显著
    //
    // ⚠️ RBF 矩阵复杂度 O(n³)：n=500 时约 1.25亿次运算，会卡死 Node.js 主线程。
    //    对数据做均匀降采样，保留至多 RBF_MAX 个支撑点用于建曲面，
    //    再对全量散点做插值（仅 O(n_full × n_rbf)）。
    const RBF_MAX = 120; // 120³ ≈ 170万次，约 5-10ms，安全范围
    let rbfPoints = rawPoints;
    if (rawPoints.length > RBF_MAX) {
      const step = rawPoints.length / RBF_MAX;
      rbfPoints = Array.from({ length: RBF_MAX }, (_, i) => rawPoints[Math.round(i * step)]);
    }

    const srcK = rbfPoints.map(p => p.strike);
    const srcT = rbfPoints.map(p => p.tenor);
    const srcIV = rbfPoints.map(p => p.iv);

    // 对全量点插值（query 点为全量 rawPoints）
    const qK = rawPoints.map(p => p.strike);
    const qT = rawPoints.map(p => p.tenor);
    const ivSurfaceValues = rbfCubicInterpolate(srcK, srcT, srcIV, qK, qT, smoothLambda);

    // ── Step 3：计算残差标准差 σ ──
    const residuals = rawPoints.map((p, i) => p.iv - ivSurfaceValues[i]);
    const meanRes = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const variance = residuals.reduce((a, b) => a + (b - meanRes) ** 2, 0) / residuals.length;
    const sigma = Math.sqrt(variance);

    // 用户指定的 σ 倍数：threshold = sigmaMultiplier * sigma
    const threshold = sigmaMultiplier * sigma;

    // ── Step 4：双判定异常检测 ──
    // 判定1（统计学）：|ε| > sigmaMultiplier * σ 且 bid/ask 侧 IV 同向确认
    // 判定2（绝对百分比）：|(IV_market - IV_surface) / IV_surface| > absPctThreshold
    // 两个条件满足其一即标记为异常
    const points: IVPoint[] = rawPoints.map((p, i) => {
      const ivSurface = Math.max(ivSurfaceValues[i], 0.001);
      const residual = residuals[i];

      // 绝对百分比偏离
      const absDev = Math.abs(residual) / ivSurface;

      let anomalyType: 'overpriced' | 'underpriced' | 'normal' = 'normal';

      if (residual > 0) {
        // 高估方向
        const sigmaHit = residual > threshold && p.ivBid > ivSurface + threshold;
        const absPctHit = absPctThreshold > 0 && absDev > absPctThreshold;
        if (sigmaHit || absPctHit) anomalyType = 'overpriced';
      } else {
        // 低估方向
        const sigmaHit = residual < -threshold && p.ivAsk < ivSurface - threshold;
        const absPctHit = absPctThreshold > 0 && absDev > absPctThreshold;
        if (sigmaHit || absPctHit) anomalyType = 'underpriced';
      }

      const stressAmt = stressMap.get(p.instrument);
      const base: IVPoint = {
        ...p,
        underlyingPrice: p.S,
        ivSurface,
        residual,
        anomalyType,
        ...(stressAmt !== undefined ? { stressInjected: true, stressAmt } : {}),
      };

      if (anomalyType !== 'normal') {
        const winProb = calcWinProb(residual, sigma);
        const pnl = calcPnL(p.S, p.strike, p.tenor, r, p.iv, ivSurface, sigma, anomalyType);
        const ev = winProb * pnl.expectedProfit - (1 - winProb) * pnl.expectedLoss;

        const stopLossIV = anomalyType === 'overpriced'
          ? p.iv + 3.5 * sigma
          : Math.max(p.iv - 3.5 * sigma, 0.01);

        base.tradeAnalysis = {
          winProb,
          currentPrice: pnl.currentPrice,
          targetPrice: pnl.targetPrice,
          shockPrice: pnl.shockPrice,
          expectedProfit: pnl.expectedProfit,
          expectedLoss: pnl.expectedLoss,
          ev,
          takeProfitIV: ivSurface,
          stopLossIV,
        };
      }

      return base;
    });

    const overpricedCount = points.filter(p => p.anomalyType === 'overpriced').length;
    const underpricedCount = points.filter(p => p.anomalyType === 'underpriced').length;

    return NextResponse.json({
      points,
      underlyingPrice: underlying,
      fetchedAt: new Date(windowTs).toISOString(),
      count: points.length,
      overpricedCount,
      underpricedCount,
      sigmaThreshold: threshold,
      residualSigma: sigma,
      // SVI/RND 由独立接口 /api/rnd-surface 提供（避免阻塞主接口）
      sviParams: {},
      rndSlices: {},
      params: {
        sigmaMultiplier,
        absPctThreshold,
        smoothLambda,
        stressMode,
        stressCount: stressMode ? stressCount : 0,
      },
    } satisfies SurfaceResponse);

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
