/**
 * Black-Scholes 定价引擎 v2
 * 包含：基础Greeks + 高阶Greeks（Vanna/Volga/Charm）
 *
 * 数学基础（Itô 引理展开）：
 *   dC = Theta·dt + Delta·dS + ½·Gamma·dS² + Vega·dσ
 *      + Vanna·dS·dσ + ½·Volga·dσ² + Charm·dt·dS + ...
 *
 * 高阶Greeks 解析式（欧式期权）：
 *   Vanna  = ∂²C/∂S∂σ = -nd1 · d2/σ
 *   Volga  = ∂²C/∂σ²  = Vega · d1·d2/σ
 *   Charm  = ∂²C/∂S∂t = -nd1·[2(r-q)T - d2·σ·√T] / (2T·σ·√T)
 */

// 累积正态分布（Abramowitz & Stegun 近似，误差 < 7.5e-8）
export function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t * (0.319381530 +
      t * (-0.356563782 +
        t * (1.781477937 +
          t * (-1.821255978 +
            t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

export function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface BSResult {
  price: number;
  delta: number;
  gamma: number;
  vega: number;      // 每1% IV变化的价格变化
  theta: number;     // 每日时间衰减
  rho: number;
  // 高阶
  vanna: number;     // ∂Delta/∂σ = ∂Vega/∂S   单位：per unit S, per unit vol
  volga: number;     // ∂Vega/∂σ = ∂²C/∂σ²     单位：per 1% vol change squared
  charm: number;     // ∂Delta/∂t               单位：per day
  // d1/d2 暴露（供 Dupire 计算使用）
  d1: number;
  d2: number;
}

/**
 * Black-Scholes 完整定价（含高阶Greeks）
 * @param S 标的现价
 * @param K 行权价
 * @param T 到期时间（年化）
 * @param r 无风险利率
 * @param sigma 波动率
 * @param isCall true=call, false=put
 * @param q 连续分红/资金费率（默认0）
 */
export function bsPrice(
  S: number, K: number, T: number, r: number,
  sigma: number, isCall: boolean, q = 0
): BSResult {
  if (T <= 1e-6) {
    const intrinsic = isCall ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0, vanna: 0, volga: 0, charm: 0, d1: 0, d2: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const nd1 = normPDF(d1);
  const discount = Math.exp(-r * T);
  const fwdDiscount = Math.exp(-q * T);

  const price = isCall
    ? S * fwdDiscount * normCDF(d1) - K * discount * normCDF(d2)
    : K * discount * normCDF(-d2) - S * fwdDiscount * normCDF(-d1);

  const delta = isCall
    ? fwdDiscount * normCDF(d1)
    : -fwdDiscount * normCDF(-d1);

  const gamma = fwdDiscount * nd1 / (S * sigma * sqrtT);

  // Vega：每1%波动率变化的价格变动
  const vegaRaw = S * fwdDiscount * nd1 * sqrtT; // per unit vol
  const vega = vegaRaw / 100;

  const theta = isCall
    ? (-(S * fwdDiscount * nd1 * sigma) / (2 * sqrtT)
      - r * K * discount * normCDF(d2)
      + q * S * fwdDiscount * normCDF(d1)) / 365
    : (-(S * fwdDiscount * nd1 * sigma) / (2 * sqrtT)
      + r * K * discount * normCDF(-d2)
      - q * S * fwdDiscount * normCDF(-d1)) / 365;

  const rho = isCall
    ? K * T * discount * normCDF(d2) / 100
    : -K * T * discount * normCDF(-d2) / 100;

  // ── 高阶 Greeks ──────────────────────────────────────────────────────
  // Vanna = ∂Vega/∂S = ∂Delta/∂σ
  //       = -nd1 · d2 / σ  （单位：per unit σ per unit S，这里除以100使单位per 1%vol）
  const vanna = -fwdDiscount * nd1 * d2 / (sigma * 100);

  // Volga = ∂²C/∂σ² = Vega × d1 × d2 / σ
  //       单位：per (1% vol)² → 故乘以 vegaRaw * d1 * d2 / (sigma * 10000)
  const volga = vegaRaw * d1 * d2 / (sigma * 10000);

  // Charm = ∂Delta/∂t（每年衰减率，除以365转为每日）
  // call: -q·e^{-qT}·N(d1) + e^{-qT}·nd1·[2(r-q)T - d2·σ·√T] / (2T·σ·√T)
  const charmNumer = 2 * (r - q) * T - d2 * sigma * sqrtT;
  const charm = isCall
    ? (fwdDiscount * (q * normCDF(d1) - nd1 * charmNumer / (2 * T * sigma * sqrtT))) / 365
    : (fwdDiscount * (-q * normCDF(-d1) - nd1 * charmNumer / (2 * T * sigma * sqrtT))) / 365;

  return { price, delta, gamma, vega, theta, rho, vanna, volga, charm, d1, d2 };
}

/**
 * 隐含波动率反解（Newton-Raphson + Brent 二分法兜底）
 */
export function impliedVol(
  marketPrice: number,
  S: number, K: number, T: number,
  r: number, isCall: boolean, q = 0
): number | null {
  if (T <= 1e-6) return null;

  const intrinsic = isCall
    ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0)
    : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);
  if (marketPrice < intrinsic - 1e-6) return null;
  if (marketPrice <= 1e-8) return null;

  // Newton-Raphson（Vega 驱动）
  let sigma = 0.5;
  for (let i = 0; i < 100; i++) {
    const res = bsPrice(S, K, T, r, sigma, isCall, q);
    const diff = res.price - marketPrice;
    const vegaRaw = res.vega * 100;
    if (Math.abs(diff) < 1e-8) return sigma;
    if (Math.abs(vegaRaw) < 1e-10) break;
    sigma -= diff / vegaRaw;
    if (sigma <= 1e-4) sigma = 1e-4;
    if (sigma > 20) sigma = 20;
  }

  // Brent 二分法兜底
  let lo = 1e-4, hi = 20;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, mid, isCall, q).price;
    if (Math.abs(p - marketPrice) < 1e-8) return mid;
    if (p < marketPrice) lo = mid; else hi = mid;
    if (hi - lo < 1e-8) return mid;
  }
  return (lo + hi) / 2;
}

/**
 * P&L 路径估算（二阶 Taylor 展开）
 * ΔC ≈ Vega·Δσ + ½·Volga·Δσ² + Vanna·ΔS·Δσ + Theta·Δt
 */
export function estimatePnL(
  res: BSResult,
  deltaIV: number,  // 预期 IV 变化（单位：1，如 -0.05 = -5pp）
  deltaS: number,   // 预期标的价格变化
  deltaDays: number // 持仓天数
): { vegaPnL: number; volgaPnL: number; vannaPnL: number; thetaPnL: number; total: number } {
  // Vega·Δσ（Vega 单位是每1%，所以Δσ用百分比）
  const vegaPnL = res.vega * deltaIV * 100;
  // ½·Volga·(Δσ)²（Volga 单位是每(1%)²）
  const volgaPnL = 0.5 * res.volga * (deltaIV * 100) ** 2;
  // Vanna·ΔS·Δσ
  const vannaPnL = res.vanna * deltaS * deltaIV * 100;
  // Theta·Δt
  const thetaPnL = res.theta * deltaDays;
  return { vegaPnL, volgaPnL, vannaPnL, thetaPnL, total: vegaPnL + volgaPnL + vannaPnL + thetaPnL };
}
