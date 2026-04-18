// lib/data/exchanges/binance.ts
import type { ExchangeFetcher } from './types';
import type { OptionContract, MarketSnapshot } from '@/types';
import { impliedVol } from '@/lib/engine/blackScholes';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { generateMockSnapshot } from '@/lib/data/mock-utils';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// 使用VPN代理端口59527
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:59527');
const axiosConfig = {
  httpAgent: proxyAgent,
  httpsAgent: proxyAgent,
  proxy: false, // 禁用axios默认的proxy配置
  timeout: 30000
};

const RISK_FREE = 0.05;

function tte(expiry: string): number {
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  return Math.max(days, 0) / 365;
}

function moneyness(strike: number, forward: number, t: number): number {
  if (t <= 0) return 0;
  return Math.log(strike / forward) / Math.sqrt(t);
}

function parseBinanceExpiry(expiryMs: number): string {
  const date = new Date(expiryMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class BinanceFetcher implements ExchangeFetcher {
  readonly id = 'binance' as const;
  readonly name = 'Binance';

  async fetchOptions(): Promise<MarketSnapshot> {
    console.log('========== BINANCE FETCHER (axios) ==========');
    try {
      console.log('[BinanceFetcher] Starting fetch...');

      const idxRes = await axios.get(
        'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
        axiosConfig
      );
      const spot: number = parseFloat(idxRes.data.price ?? 0);
      if (spot <= 0) throw new Error('invalid BTC index price');
      console.log('[BinanceFetcher] Spot:', spot);

      const exchInfoRes = await axios.get(
        'https://eapi.binance.com/eapi/v1/exchangeInfo',
        axiosConfig
      );

      const allInstruments: any[] = (exchInfoRes.data.optionSymbols ?? exchInfoRes.data.symbols ?? []).filter((s: any) =>
        s.symbol.startsWith('BTC-') && s.status === 'TRADING'
      );
      console.log('[BinanceFetcher] Total instruments:', allInstruments.length);

      const byExpiry = new Map<number, any[]>();
      for (const inst of allInstruments) {
        const exp = inst.expiryDate ?? 0;
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
      console.log('[BinanceFetcher] Selected instruments:', selectedInsts.length);

      const tickerRes = await axios.get(
        'https://eapi.binance.com/eapi/v1/ticker',
        axiosConfig
      );

      const tickerMap = new Map<string, any>();
      for (const t of tickerRes.data) {
        tickerMap.set(t.symbol, t);
      }
      console.log('[BinanceFetcher] Tickers fetched:', tickerMap.size);

      const contracts: OptionContract[] = [];
      const nowMs = Date.now();

      for (const inst of selectedInsts) {
        const symbol = inst.symbol;
        const ticker = tickerMap.get(symbol);
        if (!ticker) continue;

        const bidPrice: number = parseFloat(ticker.bidPrice ?? 0);
        const askPrice: number = parseFloat(ticker.askPrice ?? 0);
        if (bidPrice <= 0 || askPrice <= 0 || askPrice < bidPrice) continue;

        const bid = bidPrice;
        const ask = askPrice;
        const midPrice = (bid + ask) / 2;

        const strike: number = parseFloat(inst.strikePrice ?? 0);
        if (strike < spot * 0.4 || strike > spot * 2.0) continue;

        const expiryStr = parseBinanceExpiry(inst.expiryDate ?? 0);
        const t = tte(expiryStr);
        if (t < 1 / 365) continue;

        const isCall: boolean = inst.side === 'CALL';

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
          volume: parseFloat(ticker.volume ?? 0),
          openInterest: parseFloat(ticker.openInterest ?? 0),
          impliedVol: iv,
          tte: t,
          moneyness: mono,
        });
      }

      console.log('[BinanceFetcher] Valid contracts:', contracts.length);
      if (contracts.length === 0) throw new Error('no valid contracts parsed');
      return {
        symbol: 'BTC',
        source: 'binance',
        underlyingPrice: spot,
        fetchedAt: Date.now(),
        contracts,
        isMock: false,
        exchangeId: 'binance'
      };
    } catch (e) {
      console.warn('[BinanceFetcher] fallback to mock:', e);
      let fallbackSpot = 80000;
      try {
        const r = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { ...axiosConfig, timeout: 3000 });
        fallbackSpot = parseFloat(r.data.price ?? fallbackSpot);
      } catch { /* ignore */ }
      const snapshot = generateMockSnapshot('BTC', fallbackSpot);
      return { ...snapshot, isMock: true, exchangeId: 'binance', source: 'binance' };
    }
  }
}
