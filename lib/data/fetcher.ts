/**
 * 数据接入层
 *
 * BTC 期权：Deribit 公开 REST API（无需鉴权）
 * 美股期权：Polygon.io REST API（需要 POLYGON_API_KEY 环境变量）
 *
 * 接口均做了 mock fallback：API 不可达时自动生成仿真数据，
 * 保证系统可在无密钥环境下演示。
 */

import type { OptionContract, MarketSnapshot } from '@/types';
import { impliedVol } from '@/lib/engine/blackScholes';
import { differenceInCalendarDays, parseISO } from 'date-fns';

const RISK_FREE = 0.05; // 美国无风险利率（10y treasury 近似）

// ─── 工具函数 ─────────────────────────────────────────────────────────
function tte(expiry: string): number {
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  return Math.max(days, 0) / 365;
}

function moneyness(strike: number, forward: number, t: number): number {
  if (t <= 0) return 0;
  return Math.log(strike / forward) / Math.sqrt(t);
}

// ─── Deribit BTC 期权 ─────────────────────────────────────────────────
/**
 * 数据抓取流程（对齐 btc_iv_tunnel.py DeribitDataFetcher）：
 *   1. get_instruments  → 获取所有活跃期权合约列表（含 strike / expiration_timestamp）
 *   2. get_index_price  → 获取 BTC 当前指数价格（现货价）
 *   3. get_ticker       → 并发批量获取各合约双边报价（best_bid_price / best_ask_price）
 *      - get_ticker 返回的价格单位是 BTC（小数），需 × index_price 换算为 USD
 *      - 双边报价必须同时 > 0，否则跳过（避免单边市场导致 IV 失真）
 *   4. 按到期日分组均匀采样，最多 MAX_PER_EXPIRY 个/期，保证全期限覆盖
 */
export async function fetchBTCOptions(): Promise<MarketSnapshot> {
  try {
    // ── Step 1: 获取合约列表 & 现货价（并发）──────────────────────────
    const [instrRes, idxRes] = await Promise.all([
      fetch(
        'https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false',
        { signal: AbortSignal.timeout(10000) }
      ),
      fetch(
        'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd',
        { signal: AbortSignal.timeout(8000) }
      ),
    ]);

    if (!instrRes.ok) throw new Error('deribit instruments failed');
    const [instrData, idxData] = await Promise.all([instrRes.json(), idxRes.json()]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allInstruments: any[] = (instrData.result ?? []).filter((i: any) => i.is_active);
    const spot: number = idxData.result?.index_price ?? 0;
    if (spot <= 0) throw new Error('invalid BTC index price');

    // ── Step 2: 按到期日分组均匀采样 ──────────────────────────────────
    // 保留 instrument 原始对象（含 expiration_timestamp / strike / option_type）
    const byExpiry = new Map<string, any[]>();
    for (const inst of allInstruments) {
      const exp = inst.instrument_name.split('-')[1] ?? '';
      if (!byExpiry.has(exp)) byExpiry.set(exp, []);
      byExpiry.get(exp)!.push(inst);
    }

    const MAX_PER_EXPIRY = 20;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // ── Step 3: 并发批量调用 get_ticker（每批 50 个，与 Python 对齐）──
    // get_ticker 返回 best_bid_price / best_ask_price，单位是 BTC，需 × spot → USD
    const BATCH_SIZE = 50;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tickerMap = new Map<string, any>();

    for (let i = 0; i < selectedInsts.length; i += BATCH_SIZE) {
      const batch = selectedInsts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(inst =>
          fetch(
            `https://www.deribit.com/api/v2/public/ticker?instrument_name=${inst.instrument_name}`,
            { signal: AbortSignal.timeout(8000) }
          ).then(r => r.json()).catch(() => null)
        )
      );
      for (let j = 0; j < batch.length; j++) {
        const res = results[j];
        if (res?.result) tickerMap.set(batch[j].instrument_name, res.result);
      }
    }

    // ── Step 4: 解析合约 ───────────────────────────────────────────────
    const contracts: OptionContract[] = [];
    const nowMs = Date.now();

    for (const inst of selectedInsts) {
      const name: string = inst.instrument_name;
      const ticker = tickerMap.get(name);
      if (!ticker) continue;

      // 双边报价必须同时存在（与 Python 过滤逻辑一致）
      const bidBtc: number = ticker.best_bid_price ?? 0;
      const askBtc: number = ticker.best_ask_price ?? 0;
      if (bidBtc <= 0 || askBtc <= 0 || askBtc < bidBtc) continue;

      // get_ticker 价格单位 = BTC → 乘以 index_price 换算为 USD
      const bid = bidBtc * spot;
      const ask = askBtc * spot;
      const midPrice = (bid + ask) / 2;

      const strike: number = inst.strike ?? parseFloat(name.split('-')[2]);
      // 过滤极端行权价（与 Python 一致：0.4x ~ 2.0x spot）
      if (strike < spot * 0.4 || strike > spot * 2.0) continue;

      // 到期时间：优先用 expiration_timestamp（毫秒），精度高于字符串解析
      const expiryMs: number = inst.expiration_timestamp ?? 0;
      const t = expiryMs > 0
        ? Math.max((expiryMs - nowMs) / (365 * 24 * 3600 * 1000), 0)
        : (() => {
            const expiryDate = parseDeribitExpiry(name.split('-')[1] ?? '');
            return expiryDate ? tte(expiryDate) : 0;
          })();
      if (t < 1 / 365) continue; // 剩余不足 1 天

      // expiry 字符串（YYYY-MM-DD）用于 UI 分组
      const expiryDate = new Date(expiryMs > 0 ? expiryMs : Date.now());
      const expiryStr = expiryDate.toISOString().split('T')[0];

      const isCall: boolean = (inst.option_type ?? name.split('-')[3]) === 'call'
        || name.split('-')[3] === 'C';

      const iv = impliedVol(midPrice, spot, strike, t, 0, isCall, 0);
      if (!iv || iv < 0.05 || iv > 5) continue;

      const fwd = spot; // BTC 期权无风险利率取 0，forward ≈ spot
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
        volume: ticker.stats?.volume ?? 0,
        openInterest: ticker.open_interest ?? 0,
        impliedVol: iv,
        tte: t,
        moneyness: mono,
      });
    }

    if (contracts.length === 0) throw new Error('no valid contracts parsed');
    return { symbol: 'BTC', source: 'deribit', underlyingPrice: spot, fetchedAt: Date.now(), contracts };
  } catch (e) {
    console.warn('[fetchBTCOptions] fallback to mock:', e);
    let fallbackSpot = 80000;
    try {
      const r = await fetch('https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      fallbackSpot = d.result?.index_price ?? fallbackSpot;
    } catch { /* ignore */ }
    return generateMockSnapshot('BTC', fallbackSpot);
  }
}

function parseDeribitExpiry(raw: string): string | null {
  // e.g. "11JAN25" → "2025-01-11"
  const m = raw.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
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

// ─── Yahoo Finance 美股期权 ───────────────────────────────────────────
// ─── Polygon.io 美股期权 ──────────────────────────────────────────────
/**
 * 获取美股期权链（Polygon.io REST API）
 * 需要环境变量 POLYGON_API_KEY
 * 免费版限制：每分钟 5 次请求，数据延迟约 15 分钟
 * @param ticker 股票代码 e.g. NVDA / AAPL
 */
export async function fetchStockOptions(ticker: string): Promise<MarketSnapshot> {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) throw new Error('POLYGON_API_KEY not configured');

  try {
    // 1. 获取现货价（Polygon Previous Close）
    const quoteRes = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!quoteRes.ok) throw new Error(`quote ${quoteRes.status}`);
    const quoteData = await quoteRes.json();
    const spot: number = quoteData.results?.[0]?.c ?? 0;
    if (spot <= 0) throw new Error('invalid spot price');

    // 2. 拉取期权链快照（分页获取，每页250条，最多取4页=1000条）
    const contracts: OptionContract[] = [];
    const MAX_PAGES = 4;
    let url: string | null =
      `https://api.polygon.io/v3/snapshot/options/${ticker}` +
      `?limit=250&apiKey=${apiKey}`;

    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`options snapshot ${res.status}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();

      for (const item of data.results ?? []) {
        const details = item.details ?? {};
        const expiryDate: string = details.expiration_date; // "YYYY-MM-DD"
        const strike: number = details.strike_price;
        const isCall: boolean = details.contract_type === 'call';

        if (!expiryDate || !strike) continue;
        const t = tte(expiryDate);
        if (t <= 0) continue;

        const fwd = spot * Math.exp(RISK_FREE * t);
        const mono = moneyness(strike, fwd, t);
        // 过滤极度虚值（|moneyness| > 2σ）
        if (Math.abs(mono) > 2) continue;

        // 价格：优先用 fmv（fair market value），其次用 day.close
        const fmv: number = item.fmv ?? 0;
        const dayClose: number = item.day?.close ?? 0;
        const bid: number = item.last_quote?.bid ?? 0;
        const ask: number = item.last_quote?.ask ?? 0;

        let midPrice = fmv > 0 ? fmv : (bid > 0 && ask > 0 ? (bid + ask) / 2 : dayClose);
        if (midPrice <= 0) continue;

        // Polygon 直接返回 IV（小数形式），如果有就直接用，否则反推
        let iv: number = item.implied_volatility ?? 0;
        if (!iv || iv < 0.01 || iv > 5) {
          const computed = impliedVol(midPrice, spot, strike, t, RISK_FREE, isCall);
          if (!computed || computed < 0.01 || computed > 1.5) continue;
          iv = computed;
        }
        if (iv > 1.5) continue; // 美股期权 IV 超过 150% 视为异常

        contracts.push({
          symbol: ticker,
          expiry: expiryDate,
          strike,
          optionType: isCall ? 'call' : 'put',
          marketPrice: midPrice,
          underlyingPrice: spot,
          bid,
          ask,
          volume: item.day?.volume ?? 0,
          openInterest: item.open_interest ?? 0,
          impliedVol: iv,
          tte: t,
          moneyness: mono,
        });
      }

      // 处理分页
      url = data.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
    }

    if (contracts.length === 0) throw new Error('no contracts parsed');
    return { symbol: ticker, source: 'polygon', underlyingPrice: spot, fetchedAt: Date.now(), contracts };
  } catch (e) {
    console.warn(`[fetchStockOptions:${ticker}] fallback to mock:`, e);
    const mockPrices: Record<string, number> = {
      AAPL: 195, MSFT: 420, NVDA: 875, AMZN: 185,
      GOOGL: 175, META: 520, TSLA: 175, 'BRK-B': 410,
      JPM: 200, V: 280,
    };
    return generateMockSnapshot(ticker, mockPrices[ticker] ?? 200);
  }
}

// ─── Mock 数据生成器 ──────────────────────────────────────────────────
/**
 * 生成拟真的期权链 mock 数据
 * 基于参数化 SVI 曲面 + 随机注入若干 "异常凸起点"（用于演示）
 */
export function generateMockSnapshot(symbol: string, spot: number): MarketSnapshot {
  const contracts: OptionContract[] = [];
  const today = new Date();

  // 6 个到期日（7d / 14d / 30d / 60d / 90d / 180d）
  const expiries = [7, 14, 30, 60, 90, 180].map(d => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + d);
    return dt.toISOString().split('T')[0];
  });

  // SVI 基准参数（模拟 BTC/股票的典型形态）
  const baseSVI = {
    a: 0.04, b: 0.3, rho: -0.35, m: 0.0, sigma: 0.25,
  };

  // 随机选 3~5 个注入异常的位置
  const anomalySeeds: Set<string> = new Set();
  const anomalyCount = 4;
  for (let i = 0; i < anomalyCount; i++) {
    const ei = Math.floor(Math.random() * expiries.length);
    const ki = Math.floor(Math.random() * 11);
    anomalySeeds.add(`${ei}-${ki}`);
  }

  expiries.forEach((expiry, ei) => {
    const t = tte(expiry);
    if (t <= 0) return;
    const fwd = spot * Math.exp(RISK_FREE * t);

    // strike range: ±40% moneyness
    const strikeMultipliers = [-0.35, -0.25, -0.15, -0.08, -0.04, 0, 0.04, 0.08, 0.15, 0.25, 0.35];

    strikeMultipliers.forEach((m, ki) => {
      const strike = Math.round(fwd * Math.exp(m * Math.sqrt(t)) / 10) * 10;
      const k = Math.log(strike / fwd);

      // SVI 真实 IV
      const w = baseSVI.a + baseSVI.b * (
        baseSVI.rho * (k - baseSVI.m) +
        Math.sqrt((k - baseSVI.m) ** 2 + baseSVI.sigma ** 2)
      );
      let trueIV = Math.sqrt(Math.max(w / t, 0.01));

      // 注入异常
      const isAnomaly = anomalySeeds.has(`${ei}-${ki}`);
      let anomalyBump = 0;
      if (isAnomaly) {
        // 随机凸起（+20%~+40%）或凹陷（-20%~-30%）
        anomalyBump = (Math.random() > 0.5 ? 1 : -1) *
          (0.2 + Math.random() * 0.2) * trueIV;
        trueIV = Math.max(trueIV + anomalyBump, 0.05);
      }

      // 添加市场噪音 ±1%
      const noisyIV = trueIV * (1 + (Math.random() - 0.5) * 0.02);

      for (const isCall of [true, false]) {
        const { price } = bsFromIV(spot, strike, t, RISK_FREE, noisyIV, isCall);
        if (price < 0.001 * spot) return; // 忽略极深虚值

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
  };
}

// 简化 BS 价格计算（用于 mock 生成）
function bsFromIV(S: number, K: number, T: number, r: number, iv: number, isCall: boolean) {
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  const normCDF = (x: number) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    const cdf = 1 - pdf * poly;
    return x >= 0 ? cdf : 1 - cdf;
  };
  const price = isCall
    ? S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
    : K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
  return { price: Math.max(price, 0) };
}
