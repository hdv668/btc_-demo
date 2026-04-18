// lib/data/exchanges/bybit-browser.ts
// 浏览器端直接调用Bybit API
import type { OptionContract, MarketSnapshot } from '@/types';
import { impliedVol } from '@/lib/engine/blackScholes';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { generateMockSnapshot } from '@/lib/data/mock-utils';

const RISK_FREE = 0.05;

function tte(expiry: string): number {
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  return Math.max(days, 0) / 365;
}

function moneyness(strike: number, forward: number, t: number): number {
  if (t <= 0) return 0;
  return Math.log(strike / forward) / Math.sqrt(t);
}

function parseBybitExpiry(expiryStr: string): string {
  const year = expiryStr.slice(0, 4);
  const month = expiryStr.slice(4, 6);
  const day = expiryStr.slice(6, 8);
  return `${year}-${month}-${day}`;
}

export async function fetchBybitOptionsBrowser(): Promise<MarketSnapshot> {
  console.log('========== BYBIT BROWSER FETCHER ==========');
  try {
    console.log('[BybitBrowser] Starting fetch...');

    const idxRes = await fetch(
      'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
      { signal: AbortSignal.timeout(15000) }
    );
    if (!idxRes.ok) throw new Error('bybit index price failed');
    const idxData = await idxRes.json();
    console.log('[BybitBrowser] Index price response:', idxData);
    const spot: number = parseFloat(idxData.result?.list?.[0]?.lastPrice ?? 0);
    if (spot <= 0) throw new Error('invalid BTC index price');
    console.log('[BybitBrowser] Spot:', spot);

    const instrRes = await fetch(
      'https://api.bybit.com/v5/market/instruments-info?category=option&baseCoin=BTC',
      { signal: AbortSignal.timeout(20000) }
    );
    if (!instrRes.ok) throw new Error('bybit instruments failed');
    const instrData = await instrRes.json();
    console.log('[BybitBrowser] Instruments response (full):', JSON.stringify(instrData, null, 2));

    const allInstruments: any[] = instrData.result?.list ?? [];
    console.log('[BybitBrowser] Total instruments:', allInstruments.length);
    if (allInstruments.length > 0) {
      console.log('[BybitBrowser] First instrument sample:', JSON.stringify(allInstruments[0], null, 2));
    }

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
    console.log('[BybitBrowser] Selected instruments:', selectedInsts.length);

    const tickerRes = await fetch(
      'https://api.bybit.com/v5/market/tickers?category=option&baseCoin=BTC',
      { signal: AbortSignal.timeout(20000) }
    );
    if (!tickerRes.ok) throw new Error('bybit tickers failed');
    const tickerData = await tickerRes.json();
    console.log('[BybitBrowser] Tickers response:', tickerData);

    const tickerMap = new Map<string, any>();
    for (const t of tickerData.result?.list ?? []) {
      tickerMap.set(t.symbol, t);
    }
    console.log('[BybitBrowser] Tickers fetched:', tickerMap.size);

    const contracts: OptionContract[] = [];
    const nowMs = Date.now();

    console.log('[BybitBrowser] Starting contract parsing, selectedInsts:', selectedInsts.length);
    if (selectedInsts.length > 0) {
      console.log('[BybitBrowser] Sample inst:', selectedInsts[0]);
      console.log('[BybitBrowser] Sample ticker:', tickerMap.get(selectedInsts[0].symbol));
    }

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

      // 从 symbol 中解析 strike 和 expiry，因为 instruments-info 没有这些字段
      // symbol 格式: BTC-26MAR27-78000-P-USDT
      const symbolParts = symbol.split('-');
      if (symbolParts.length < 4) continue;

      const strike: number = parseFloat(symbolParts[2]);
      if (isNaN(strike) || strike < spot * 0.3 || strike > spot * 3.0) continue;

      // 转换日期格式: 26MAR27 -> 2027-03-26
      const expiryStr = (() => {
        const dateStr = symbolParts[1]; // "26MAR27"
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
      if (t < 0 / 365) continue;

      const isCall: boolean = inst.optionsType === 'Call';

      const iv = impliedVol(midPrice, spot, strike, t, 0, isCall, 0);
      if (!iv || iv < 0.01 || iv > 10) continue;

      const fwd = spot;
      const mono = moneyness(strike, fwd, t);
      if (Math.abs(mono) > 4) continue;

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
    console.log('[BybitBrowser] Contracts parsed:', contracts.length);

    console.log('[BybitBrowser] Valid contracts:', contracts.length);
    if (contracts.length === 0) throw new Error('no valid contracts parsed');
    return {
      symbol: 'BTC',
      source: 'bybit',
      underlyingPrice: spot,
      fetchedAt: Date.now(),
      contracts,
      isMock: false,
      exchangeId: 'bybit'
    };
  } catch (e) {
    console.warn('[BybitBrowser] failed, fallback to mock:', e);
    let fallbackSpot = 80000;
    try {
      const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      fallbackSpot = parseFloat(d.result?.list?.[0]?.lastPrice ?? fallbackSpot);
    } catch { /* ignore */ }
    const snapshot = generateMockSnapshot('BTC', fallbackSpot);
    return { ...snapshot, isMock: true, exchangeId: 'bybit', source: 'bybit' };
  }
}
