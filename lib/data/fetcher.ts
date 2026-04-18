// lib/data/fetcher.ts
import type { OptionContract, MarketSnapshot } from '@/types';
import { impliedVol } from '@/lib/engine/blackScholes';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { exchangeRegistry } from './exchanges/registry';
import type { ExchangeId } from './exchanges/types';

const RISK_FREE = 0.05;

function tte(expiry: string): number {
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  return Math.max(days, 0) / 365;
}

export function generateMockSnapshot(symbol: string, spot: number): MarketSnapshot {
  const contracts: OptionContract[] = [];
  const today = new Date();

  const expiries = [7, 14, 30, 60, 90, 180].map(d => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + d);
    return dt.toISOString().split('T')[0];
  });

  const baseSVI = {
    a: 0.04, b: 0.3, rho: -0.35, m: 0.0, sigma: 0.25,
  };

  const anomalySeeds: Set<string> = new Set();
  const anomalyCount = 4;
  for (let i = 0; i < anomalyCount; i++) {
    const ei = Math.floor(Math.random() * expiries.length);
    const ki = Math.floor(Math.random() * 11);
    anomalySeeds.add(`${ei}-${ki}`);
  }

  function bsFromIV(S: number, K: number, T: number, r: number, iv: number, isCall: boolean) {
    const normCDF = (x: number) => {
      const t = 1 / (1 + 0.2316419 * Math.abs(x));
      const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
      const cdf = 1 - pdf * poly;
      return x >= 0 ? cdf : 1 - cdf;
    };
    const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
    const d2 = d1 - iv * Math.sqrt(T);
    const price = isCall
      ? S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
      : K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
    return { price: Math.max(price, 0) };
  }

  function moneyness(strike: number, forward: number, t: number): number {
    if (t <= 0) return 0;
    return Math.log(strike / forward) / Math.sqrt(t);
  }

  expiries.forEach((expiry, ei) => {
    const t = tte(expiry);
    if (t <= 0) return;
    const fwd = spot * Math.exp(RISK_FREE * t);

    const strikeMultipliers = [-0.35, -0.25, -0.15, -0.08, -0.04, 0, 0.04, 0.08, 0.15, 0.25, 0.35];

    strikeMultipliers.forEach((m, ki) => {
      const strike = Math.round(fwd * Math.exp(m * Math.sqrt(t)) / 10) * 10;
      const k = Math.log(strike / fwd);

      const w = baseSVI.a + baseSVI.b * (
        baseSVI.rho * (k - baseSVI.m) +
        Math.sqrt((k - baseSVI.m) ** 2 + baseSVI.sigma ** 2)
      );
      let trueIV = Math.sqrt(Math.max(w / t, 0.01));

      const isAnomaly = anomalySeeds.has(`${ei}-${ki}`);
      let anomalyBump = 0;
      if (isAnomaly) {
        anomalyBump = (Math.random() > 0.5 ? 1 : -1) *
          (0.2 + Math.random() * 0.2) * trueIV;
        trueIV = Math.max(trueIV + anomalyBump, 0.05);
      }

      const noisyIV = trueIV * (1 + (Math.random() - 0.5) * 0.02);

      for (const isCall of [true, false]) {
        const { price } = bsFromIV(spot, strike, t, RISK_FREE, noisyIV, isCall);
        if (price < 0.001 * spot) return;

        const spread = price * 0.02;
        contracts.push({
          symbol,
          expiry,
          strike,
          optionType: isCall ? 'call' : 'put',
          marketPrice: price,
          underlyingPrice: spot,
          bid: price - spread,
          ask: price + spread,
          volume: Math.round(100 + Math.random() * 5000),
          openInterest: Math.round(500 + Math.random() * 20000),
          impliedVol: noisyIV,
          tte: t,
          moneyness: moneyness(strike, fwd, t),
        });
      }
    });
  });

  return {
    symbol,
    source: 'mock',
    underlyingPrice: spot,
    fetchedAt: Date.now(),
    contracts,
    isMock: true,
  };
}

export async function fetchOptionsByExchange(exchangeId: ExchangeId): Promise<MarketSnapshot> {
  const fetcher = exchangeRegistry.get(exchangeId);
  return fetcher.fetchOptions();
}

export { fetchBTCOptions } from './exchanges/deribit';
