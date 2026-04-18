// lib/data/exchanges/binance.ts
import type { ExchangeFetcher } from './types';
import type { OptionContract, MarketSnapshot } from '@/types';
import { impliedVol } from '@/lib/engine/blackScholes';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { generateMockSnapshot } from '@/lib/data/fetcher';

const RISK_FREE = 0.05;

function tte(expiry: string): number {
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  return Math.max(days, 0) / 365;
}

function moneyness(strike: number, forward: number, t: number): number {
  if (t <= 0) return 0;
  return Math.log(strike / forward) / Math.sqrt(t);
}

export class BinanceFetcher implements ExchangeFetcher {
  readonly id = 'binance' as const;
  readonly name = 'Binance';

  async fetchOptions(): Promise<MarketSnapshot> {
    try {
      const snapshot = generateMockSnapshot('BTC', 80000);
      return { ...snapshot, isMock: true, exchangeId: 'binance', source: 'binance-mock' };
    } catch (e) {
      console.warn('[BinanceFetcher] fallback to mock:', e);
      const snapshot = generateMockSnapshot('BTC', 80000);
      return { ...snapshot, isMock: true, exchangeId: 'binance', source: 'binance-mock' };
    }
  }
}
