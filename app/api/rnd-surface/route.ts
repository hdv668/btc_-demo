import { NextRequest, NextResponse } from 'next/server';

// ─── Black-Scholes 工具函数 ───────────────────────────────────────────────────

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x >= 0 ? 1 - p : p;
}

function bsCallPrice(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

function impliedVolatility(
  S: number, K: number, T: number, r: number, marketPrice: number
): number | null {
  const intrinsic = Math.max(S - K, 0);
  if (marketPrice < intrinsic - 0.01 || marketPrice <= 0) return null;

  const bsVega = (sig: number): number => {
    if (T <= 0 || sig <= 0) return 0;
    const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T));
    return S * Math.sqrt(T) * Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  };

  let sigma = 0.5;
  for (let i = 0; i < 100; i++) {
    const price = bsCallPrice(S, K, T, r, sigma);
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-6) return sigma;
    const vega = bsVega(sigma);
    if (vega < 1e-8) break;
    sigma = sigma - diff / vega;
    if (sigma <= 0 || sigma > 5.0) break;
  }
  // 二分法备用
  let lo = 0.001, hi = 5.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bsCallPrice(S, K, T, r, mid) < marketPrice) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ─── SVI 拟合 ────────────────────────────────────────────────────────────────

function sviW(k: number, a: number, b: number, rho: number, m: number, sig: number): number {
  return a + b * (rho * (k - m) + Math.sqrt((k - m) * (k - m) + sig * sig));
}

function sviIV(k: number, tte: number, a: number, b: number, rho: number, m: number, sig: number): number | null {
  const w = sviW(k, a, b, rho, m, sig);
  if (w <= 0 || tte <= 0) return null;
  return Math.sqrt(w / tte);
}

function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  maxIter = 1500,
  tol = 1e-7
): number[] {
  const n = x0.length;
  const alpha = 1.0, beta = 0.5, gamma = 2.0, delta = 0.5;

  let simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += Math.abs(v[i]) > 1e-6 ? v[i] * 0.05 + 1e-4 : 0.05;
    simplex.push(v);
  }
  let fVals = simplex.map(f);

  for (let iter = 0; iter < maxIter; iter++) {
    const idx = Array.from({ length: n + 1 }, (_, i) => i).sort((a, b) => fVals[a] - fVals[b]);
    simplex = idx.map(i => simplex[i]);
    fVals = idx.map(i => fVals[i]);

    if (fVals[n] - fVals[0] < tol) break;

    const centroid = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;

    const xr = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = f(xr);

    if (fr < fVals[0]) {
      const xe = centroid.map((c, j) => c + gamma * (xr[j] - c));
      const fe = f(xe);
      simplex[n] = fe < fr ? xe : xr;
      fVals[n] = fe < fr ? fe : fr;
    } else if (fr < fVals[n - 1]) {
      simplex[n] = xr; fVals[n] = fr;
    } else {
      const xc = centroid.map((c, j) => c + beta * (simplex[n][j] - c));
      const fc = f(xc);
      if (fc < fVals[n]) {
        simplex[n] = xc; fVals[n] = fc;
      } else {
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
  tte: number; rmse: number;
}

function fitSVI(ks: number[], ivs: number[], tte: number): SVIFitResult | null {
  if (ks.length < 5) return null;
  const ws = ivs.map(iv => iv * iv * tte);

  const objective = ([a, b, rho, m, sig]: number[]): number => {
    const bC   = Math.max(b, 1e-6);
    const rhoC = Math.max(-0.9999, Math.min(0.9999, rho));
    const sigC = Math.max(sig, 1e-6);
    const minA = -bC * sigC * Math.sqrt(1 - rhoC * rhoC);
    const aC   = Math.max(a, minA + 1e-8);

    let sse = 0;
    for (let i = 0; i < ks.length; i++) {
      const diff = sviW(ks[i], aC, bC, rhoC, m, sigC) - ws[i];
      sse += diff * diff;
    }
    return sse / ks.length;
  };

  const atmIV = ivs.reduce((s, v) => s + v, 0) / ivs.length;
  const x0 = [atmIV * atmIV * tte * 0.5, 0.1, -0.3, 0.0, 0.2];
  const result = nelderMead(objective, x0);

  const [a, b, rho, m, sig] = result;
  const bC   = Math.max(b, 1e-6);
  const rhoC = Math.max(-0.9999, Math.min(0.9999, rho));
  const sigC = Math.max(sig, 1e-6);
  const aC   = Math.max(a, -bC * sigC * Math.sqrt(1 - rhoC * rhoC) + 1e-8);

  let sse = 0;
  for (let i = 0; i < ks.length; i++) {
    const iv_fit = sviIV(ks[i], tte, aC, bC, rhoC, m, sigC) ?? 0;
    sse += (iv_fit - ivs[i]) ** 2;
  }

  return { a: aC, b: bC, rho: rhoC, m, sigma: sigC, tte, rmse: Math.sqrt(sse / ks.length) };
}

// ─── RND 计算（Breeden-Litzenberger）────────────────────────────────────────

export interface RNDPoint {
  strike: number;
  logMoneyness: number;
  tte: number;
  expiry: string;
  density: number;
  cdf: number;
  iv: number;
}

function computeRNDSlice(
  params: SVIFitResult,
  S: number,
  r: number,
  nPoints = 200
): Omit<RNDPoint, 'expiry'>[] {
  const { a, b, rho, m, sigma: sig, tte } = params;
  const F = S * Math.exp(r * tte);

  const kMin = -1.8, kMax = 1.8;
  const kArr = Array.from({ length: nPoints }, (_, i) => kMin + (i / (nPoints - 1)) * (kMax - kMin));

  const callPrice = (K: number): number => {
    const k = Math.log(K / F);
    const iv = sviIV(k, tte, a, b, rho, m, sig);
    if (!iv || iv <= 0) return Math.max(F - K, 0);
    const sqT = Math.sqrt(tte);
    const d1 = (-k + 0.5 * iv * iv * tte) / (iv * sqT);
    const d2 = d1 - iv * sqT;
    return Math.exp(-r * tte) * (F * normCdf(d1) - K * normCdf(d2));
  };

  const result: Omit<RNDPoint, 'expiry'>[] = [];
  for (let i = 0; i < nPoints; i++) {
    const k = kArr[i];
    const K = F * Math.exp(k);
    const h = K * 0.001;
    const d2C_dK2 = (callPrice(K + h) - 2 * callPrice(K) + callPrice(K - h)) / (h * h);
    const density = Math.max(d2C_dK2 * Math.exp(r * tte), 0);
    const iv = sviIV(k, tte, a, b, rho, m, sig) ?? 0;
    result.push({ strike: K, logMoneyness: k, tte, density, cdf: 0, iv: iv * 100 });
  }

  // 归一化
  let total = 0;
  for (let i = 0; i < result.length - 1; i++) {
    total += 0.5 * (result[i].density + result[i + 1].density) * (result[i + 1].strike - result[i].strike);
  }
  if (total > 1e-10) for (const p of result) p.density /= total;

  // 累积分布
  let cumulative = 0;
  for (let i = 0; i < result.length; i++) {
    if (i > 0) cumulative += 0.5 * (result[i - 1].density + result[i].density) * (result[i].strike - result[i - 1].strike);
    result[i].cdf = Math.min(cumulative, 1);
  }

  return result;
}

// ─── Deribit 数据拉取 ─────────────────────────────────────────────────────────

async function fetchDeribitOptions(): Promise<{ result: any[]; indexPrice: number; fetchedAt: number }> {
  const fetchedAt = Date.now();
  const [bookRes, idxRes] = await Promise.all([
    fetch('https://deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option', { next: { revalidate: 0 } }),
    fetch('https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd', { next: { revalidate: 0 }, signal: AbortSignal.timeout(8000) }),
  ]);
  if (!bookRes.ok) throw new Error(`Deribit error: ${bookRes.status}`);
  const [bookJson, idxJson] = await Promise.all([bookRes.json(), idxRes.json()]);
  return { result: bookJson.result ?? [], indexPrice: idxJson.result?.index_price ?? 0, fetchedAt };
}

// ─── 接口响应类型 ─────────────────────────────────────────────────────────────

export interface SVIParams {
  a: number; b: number; rho: number; m: number; sigma: number;
  tte: number; rmse: number;
}

export interface RNDResponse {
  underlyingPrice: number;
  fetchedAt: string;
  sviParams: Record<string, SVIParams>;
  rndSlices: Record<string, RNDPoint[]>;
}

// ─── GET /api/rnd-surface ─────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    const { result: raw, indexPrice, fetchedAt: windowTs } = await fetchDeribitOptions();
    const r = 0.0;

    const underlying = indexPrice > 0
      ? indexPrice
      : (raw.find((x: any) => x.underlying_price)?.underlying_price ?? 0);
    if (!underlying) return NextResponse.json({ error: '无法获取 BTC 价格' }, { status: 503 });

    // 解析 Call 期权，计算 IV
    interface RawPt { expiry: string; strike: number; tenor: number; iv: number }
    const byExpiry = new Map<string, { ks: number[]; ivs: number[]; tte: number }>();

    for (const item of raw) {
      const name: string = item.instrument_name ?? '';
      const parts = name.split('-');
      if (parts.length !== 4 || parts[3] !== 'C') continue;

      const [, expiryStr, strikeStr] = parts;
      const bid: number = item.bid_price;
      const ask: number = item.ask_price;
      if (!bid || !ask || bid <= 0 || ask <= 0) continue;

      const strike = parseFloat(strikeStr);
      if (strike < underlying * 0.4 || strike > underlying * 2.0) continue;

      let expiry: Date;
      try {
        expiry = new Date(`${expiryStr.slice(0, -2)} 20${expiryStr.slice(-2)} 08:00:00 UTC`);
        if (isNaN(expiry.getTime())) {
          const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
          const day = parseInt(expiryStr.replace(/[A-Z]/g, ''));
          const monStr = expiryStr.slice(-5, -2).toUpperCase();
          const yr = 2000 + parseInt(expiryStr.slice(-2));
          expiry = new Date(Date.UTC(yr, months[monStr], day, 8, 0, 0));
        }
      } catch { continue; }
      if (isNaN(expiry.getTime())) continue;

      const T = (expiry.getTime() - windowTs) / (365 * 24 * 3600 * 1000);
      if (T <= 1 / 365) continue;

      const iv = impliedVolatility(underlying, strike, T, r, ((bid + ask) / 2) * underlying);
      if (iv === null || iv < 0.05 || iv > 3.0) continue;

      if (!byExpiry.has(expiryStr)) byExpiry.set(expiryStr, { ks: [], ivs: [], tte: T });
      const entry = byExpiry.get(expiryStr)!;
      entry.ks.push(Math.log(strike / underlying));
      entry.ivs.push(iv);
    }

    const sviParams: Record<string, SVIParams> = {};
    const rndSlices: Record<string, RNDPoint[]> = {};

    for (const [expiry, { ks, ivs, tte }] of byExpiry) {
      if (ks.length < 5) continue;
      const fit = fitSVI(ks, ivs, tte);
      if (!fit) continue;

      sviParams[expiry] = { a: fit.a, b: fit.b, rho: fit.rho, m: fit.m, sigma: fit.sigma, tte: fit.tte, rmse: fit.rmse };
      const pts = computeRNDSlice(fit, underlying, r);
      rndSlices[expiry] = pts.map(p => ({ ...p, expiry }));
    }

    return NextResponse.json({
      underlyingPrice: underlying,
      fetchedAt: new Date(windowTs).toISOString(),
      sviParams,
      rndSlices,
    } satisfies RNDResponse);

  } catch (err: any) {
    console.error('[rnd-surface]', err);
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 });
  }
}
