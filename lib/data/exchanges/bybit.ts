// lib/data/exchanges/bybit.ts
import type { ExchangeFetcher } from './types';
import type { OptionContract, MarketSnapshot } from '@/types';
import { impliedVol } from '@/lib/engine/blackScholes';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { generateMockSnapshot } from '@/lib/data/mock-utils';
import axios from 'axios';

const RISK_FREE = 0.05;

function tte(expiry: string): number {
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  return Math.max(days, 0) / 365;
}

function moneyness(strike: number, forward: number, t: number): number {
  if (t <= 0) return 0;
  return Math.log(strike / forward) / Math.sqrt(t);
}

export class BybitFetcher implements ExchangeFetcher {
  readonly id = 'bybit' as const;
  readonly name = 'Bybit';

  async fetchOptions(): Promise<MarketSnapshot> {
    console.log('========== BYBIT FETCHER (axios) ==========');
    try {
      console.log('[BybitFetcher] Starting fetch...');

      const idxRes = await axios.get(
        'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
        { timeout: 15000 }
      );
      const spot = parseFloat(idxRes.data.result?.list?.[0]?.lastPrice ?? 0);
      if (spot <= 0) throw new Error('invalid BTC index price');
      console.log('[BybitFetcher] Spot:', spot);

      const [instrRes, tickerRes] = await Promise.all([
        axios.get(
          'https://api.bybit.com/v5/market/instruments-info?category=option&baseCoin=BTC',
          { timeout: 20000 }
        ),
        axios.get(
          'https://api.bybit.com/v5/market/tickers?category=option&baseCoin=BTC',
          { timeout: 20000 }
        ),
      ]);

      const allInstruments: any[] = instrRes.data.result?.list ?? [];
      console.log('[BybitFetcher] Total instruments:', allInstruments.length);

      const byExpiry = new Map<string, any[]>();
      for (const inst of allInstruments) {
        const exp = inst.deliveryTime ?? '';
        if (!byExpiry.has(exp)) byExpiry.set(exp, []);
        byExpiry.get(exp)!.push(inst);
      }

      const MAX_PER_EXPIRY = 15;
      const selectedInsts: any[] = [];
      for (const group of byExpiry.values()) {
        if (group.length <= MAX_PER_EXPIRY) {
          selectedInsts.push(...group);
        } else {
          const step = group.length / MAX_PER_EXPIRY;
          for (let i = 0; i < MAX_PER_EXPIRY; i++) {
            selectedInsts.push(group[Math.floor(i * step)]);
          }
        }
      }
      console.log('[BybitFetcher] Selected instruments:', selectedInsts.length);

      const tickerMap = new Map<string, any>();
      for (const t of tickerRes.data.result?.list ?? []) {
        tickerMap.set(t.symbol, t);
      }
      console.log('[BybitFetcher] Tickers fetched:', tickerMap.size);

      const contracts: OptionContract[] = [];
      const nowMs = Date.now();

      for (const inst of selectedInsts) {
        const symbol = inst.symbol;
        const ticker = tickerMap.get(symbol);
        if (!ticker) continue;

        const bidPrice: number = parseFloat(ticker.bid1Price ?? 0);
        const askPrice: number = parseFloat(ticker.ask1Price ?? 0);
        if (bidPrice <= 0 || askPrice <= 0 || askPrice < bidPrice) continue;

        const bid = bidPrice;
        const ask = askPrice;
        const midPrice = (bid + ask) / 2;

        const symbolParts = symbol.split('-');
        if (symbolParts.length < 4) continue;

        const strike: number = parseFloat(symbolParts[2]);
        if (isNaN(strike) || strike < spot * 0.4 || strike > spot * 2.0) continue;

        const expiryStr = (() => {
          const dateStr = symbolParts[1];
          const day = dateStr.slice(0, 2);
          const monthStr = dateStr.slice(2, 5);
          const year = '20' + dateStr.slice(5, 7);

          const monthMap: Record<string, string> = {
            'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
            'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
            'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
          };
          const month = monthMap[monthStr.toUpperCase()] || '01';
          return `${year}-${month}-${day}`;
        })();
        const t = tte(expiryStr);
        if (t < 1 / 365) continue;

        const isCall: boolean = inst.optionsType === 'Call';

        const iv = impliedVol(midPrice, spot, strike, t, 0, isCall, 0);
        if (!iv || iv < 0.05 || iv > 5) continue;

        const fwd = spot;
        const mono = moneyness(strike, fwd, t);
        if (Math.abs(mono) > 3) continue;

        contracts.push({
          symbol: 'BTC',
          expiry: expiryStr,
          strike,
          optionType: isCall ? 'call' : 'put',
          marketPrice: midPrice,
          underlyingPrice: spot,
          bid,
          ask,
          volume: parseFloat(ticker.volume24h ?? 0),
          openInterest: parseFloat(ticker.openInterest ?? 0),
          impliedVol: iv,
          tte: t,
          moneyness: mono,
        });
      }

      console.log('[BybitFetcher] Valid contracts:', contracts.length);
      if (contracts.length === 0) throw new Error('no valid contracts parsed');

      return {
        symbol: 'BTC',
        source: 'bybit',
        underlyingPrice: spot,
        fetchedAt: Date.now(),
        contracts,
        isMock: false,
        exchangeId: 'bybit',
      };
    } catch (e) {
      console.warn('[BybitFetcher] fallback to mock:', e);
      let fallbackSpot = 80000;
      try {
        const r = await axios.get(
          'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
          { timeout: 3000 }
        );
        fallbackSpot = parseFloat(r.data.result?.list?.[0]?.lastPrice ?? fallbackSpot);
      } catch { /* ignore */ }
      const snapshot = generateMockSnapshot('BTC', fallbackSpot);
      return { ...snapshot, isMock: true, exchangeId: 'bybit', source: 'bybit' };
    }
  }
}
