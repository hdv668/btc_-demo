// lib/data/exchanges/binance-browser.ts
// 浏览器端直接调用Binance API
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

function parseBinanceExpiry(expiryMs: number): string {
  const date = new Date(expiryMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function fetchBinanceOptionsBrowser(): Promise<MarketSnapshot> {
  console.log('========== BINANCE BROWSER FETCHER ==========');
  try {
    console.log('[BinanceBrowser] Starting fetch...');

    const idxRes = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      { signal: AbortSignal.timeout(15000) }
    );
    if (!idxRes.ok) throw new Error('binance index price failed');
    const idxData = await idxRes.json();
    const spot: number = parseFloat(idxData.price ?? 0);
    if (spot <= 0) throw new Error('invalid BTC index price');
    console.log('[BinanceBrowser] Spot:', spot);

    const exchInfoRes = await fetch(
      'https://eapi.binance.com/eapi/v1/exchangeInfo',
      { signal: AbortSignal.timeout(20000) }
    );
    if (!exchInfoRes.ok) throw new Error('binance exchangeInfo failed');
    const exchInfo = await exchInfoRes.json();

    const allInstruments: any[] = (exchInfo.symbols ?? []).filter((s: any) =>
      s.symbol.startsWith('BTC-') && s.status === 'TRADING'
    );
    console.log('[BinanceBrowser] Total instruments:', allInstruments.length);

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
    console.log('[BinanceBrowser] Selected instruments:', selectedInsts.length);

    const tickerRes = await fetch(
      'https://eapi.binance.com/eapi/v1/ticker',
      { signal: AbortSignal.timeout(20000) }
    );
    if (!tickerRes.ok) throw new Error('binance ticker failed');
    const tickerData = await tickerRes.json();

    const tickerMap = new Map<string, any>();
    for (const t of tickerData) {
      tickerMap.set(t.symbol, t);
    }
    console.log('[BinanceBrowser] Tickers fetched:', tickerMap.size);

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

    console.log('[BinanceBrowser] Valid contracts:', contracts.length);
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
    console.warn('[BinanceBrowser] failed, fallback to mock:', e);
    let fallbackSpot = 80000;
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      fallbackSpot = parseFloat(d.price ?? fallbackSpot);
    } catch { /* ignore */ }
    const snapshot = generateMockSnapshot('BTC', fallbackSpot);
    return { ...snapshot, isMock: true, exchangeId: 'binance', source: 'binance' };
  }
}
