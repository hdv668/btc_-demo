// lib/data/exchanges/deribit-browser.ts
// 浏览器端直接调用Deribit API
import type { OptionContract, MarketSnapshot } from '@/types';
import { impliedVol } from '@/lib/engine/blackScholes';
import { differenceInCalendarDays, parseISO } from 'date-fns';

const RISK_FREE = 0.05;

function tte(expiry: string): number {
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  return Math.max(days, 0) / 365;
}

function moneyness(strike: number, forward: number, t: number): number {
  if (t <= 0) return 0;
  return Math.log(strike / forward) / Math.sqrt(t);
}

function parseDeribitExpiry(raw: string): string | null {
  const m = raw.match(/^(\\d{1,2})([A-Z]{3})(\\d{2})$/);
  if (!m) return null;
  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };
  const day = m[1].padStart(2, '0');
  const mon = months[m[2]];
  if (!mon) return null;
  const year = `20${m[3]}`;
  return `${year}-${mon}-${day}`;
}

export async function fetchBTCOptionsBrowser(): Promise<MarketSnapshot> {
  console.log('========== DERIBIT BROWSER FETCHER ==========');
  try {
    console.log('[DeribitBrowser] Starting fetch...');

    const idxRes = await fetch(
      'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd',
      { signal: AbortSignal.timeout(15000) }
    );
    if (!idxRes.ok) throw new Error('deribit index price failed');
    const idxData = await idxRes.json();
    const spot: number = idxData.result?.index_price ?? 0;
    if (spot <= 0) throw new Error('invalid BTC index price');
    console.log('[DeribitBrowser] Spot:', spot);

    const instrRes = await fetch(
      'https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false',
      { signal: AbortSignal.timeout(20000) }
    );

    if (!instrRes.ok) throw new Error('deribit instruments failed');
    const instrData = await instrRes.json();

    const allInstruments: any[] = (instrData.result ?? []).filter((i: any) => i.is_active);
    console.log('[DeribitBrowser] Total instruments:', allInstruments.length);

    const byExpiry = new Map<string, any[]>();
    for (const inst of allInstruments) {
      const exp = inst.instrument_name.split('-')[1] ?? '';
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
    console.log('[DeribitBrowser] Selected instruments:', selectedInsts.length);

    const BATCH_SIZE = 30;
    const tickerMap = new Map<string, any>();

    for (let i = 0; i < selectedInsts.length; i += BATCH_SIZE) {
      const batch = selectedInsts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(inst =>
          fetch(
            `https://www.deribit.com/api/v2/public/ticker?instrument_name=${inst.instrument_name}`,
            { signal: AbortSignal.timeout(20000) }
          ).then(r => r.json()).catch(() => null)
        )
      );
      for (let j = 0; j < batch.length; j++) {
        const res = results[j];
        if (res?.result) tickerMap.set(batch[j].instrument_name, res.result);
      }
      console.log(`[DeribitBrowser] Batch ${Math.floor(i/BATCH_SIZE)+1} done`);
    }

    const contracts: OptionContract[] = [];
    const nowMs = Date.now();

    for (const inst of selectedInsts) {
      const name: string = inst.instrument_name;
      const ticker = tickerMap.get(name);
      if (!ticker) continue;

      const bidBtc: number = ticker.best_bid_price ?? 0;
      const askBtc: number = ticker.best_ask_price ?? 0;
      if (bidBtc <= 0 || askBtc <= 0 || askBtc < bidBtc) continue;

      const bid = bidBtc * spot;
      const ask = askBtc * spot;
      const midPrice = (bid + ask) / 2;

      const strike: number = inst.strike ?? parseFloat(name.split('-')[2]);
      if (strike < spot * 0.3 || strike > spot * 3.0) continue;

      const expiryMs: number = inst.expiration_timestamp ?? 0;
      const t = expiryMs > 0
        ? Math.max((expiryMs - nowMs) / (365 * 24 * 3600 * 1000), 0)
        : (() => {
            const expiryDate = parseDeribitExpiry(name.split('-')[1] ?? '');
            return expiryDate ? tte(expiryDate) : 0;
          })();
      if (t < 0 / 365) continue;

      const expiryDate = new Date(expiryMs > 0 ? expiryMs : Date.now());
      const expiryStr = expiryDate.toISOString().split('T')[0];

      const isCall: boolean = (inst.option_type ?? name.split('-')[3]) === 'call'
        || name.split('-')[3] === 'C';

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
        volume: ticker.stats?.volume ?? 0,
        openInterest: ticker.open_interest ?? 0,
        impliedVol: iv,
        tte: t,
        moneyness: mono,
      });
    }

    console.log('[DeribitBrowser] Valid contracts:', contracts.length);
    if (contracts.length === 0) throw new Error('no valid contracts parsed');
    return {
      symbol: 'BTC',
      source: 'deribit',
      underlyingPrice: spot,
      fetchedAt: Date.now(),
      contracts,
      isMock: false,
      exchangeId: 'deribit'
    };
  } catch (e) {
    console.warn('[DeribitBrowser] failed:', e);
    throw e;
  }
}
