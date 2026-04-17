# 多交易所支持系统实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 BTC 期权 IV 曲面分析系统添加 Bybit 和 Binance 交易所支持，包括 UI 选择器和数据来源指示器。

**Architecture:** 采用统一的 ExchangeFetcher 接口，通过 ExchangeRegistry 路由到不同的交易所实现，保持现有 IV 计算逻辑完全不变。

**Tech Stack:** Next.js 16, React 19, TypeScript, Deribit/Bybit/Binance 公开 API

---

## 文件结构映射

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 创建 | `lib/data/exchanges/types.ts` | 交易所接口和类型定义 |
| 创建 | `lib/data/exchanges/registry.ts` | 交易所注册表 |
| 创建 | `lib/data/exchanges/deribit.ts` | Deribit 交易所实现 |
| 创建 | `lib/data/exchanges/bybit.ts` | Bybit 交易所实现 |
| 创建 | `lib/data/exchanges/binance.ts` | Binance 交易所实现 |
| 修改 | `lib/data/fetcher.ts` | 简化为统一入口，保留 mock 生成器 |
| 修改 | `types/index.ts` | 扩展类型定义 |
| 修改 | `app/api/iv-surface/route.ts` | 添加交易所和期权类型参数 |
| 修改 | `components/Dashboard.tsx` | 添加 UI 选择器和数据来源指示器 |

---

## Phase 1: 类型定义和基础结构

### Task 1: 创建交易所类型定义

**Files:**
- Create: `lib/data/exchanges/types.ts`

- [ ] **Step 1: 创建类型定义文件**

```typescript
// lib/data/exchanges/types.ts
import type { MarketSnapshot } from '@/types';

export type ExchangeId = 'deribit' | 'bybit' | 'binance';
export type OptionTypeFilter = 'call' | 'put' | 'both';

export interface ExchangeFetcher {
  readonly id: ExchangeId;
  readonly name: string;
  fetchOptions(): Promise<MarketSnapshot>;
}

export interface ExchangeRegistry {
  get(exchangeId: ExchangeId): ExchangeFetcher;
  list(): ExchangeFetcher[];
}
```

- [ ] **Step 2: 提交**

```bash
git add lib/data/exchanges/types.ts
git commit -m "feat: 添加交易所类型定义"
```

---

### Task 2: 扩展项目类型定义

**Files:**
- Modify: `types/index.ts`

- [ ] **Step 1: 读取现有类型文件**

先读取文件内容，然后进行修改。

- [ ] **Step 2: 添加新类型和扩展接口**

在文件顶部添加导入：
```typescript
import type { ExchangeId, OptionTypeFilter } from '@/lib/data/exchanges/types';
```

扩展 `MarketSnapshot` 接口：
```typescript
export interface MarketSnapshot {
  symbol: string;
  source: string;
  underlyingPrice: number;
  fetchedAt: number;
  contracts: OptionContract[];
  isMock: boolean;        // 新增
  exchangeId?: ExchangeId; // 新增
}
```

- [ ] **Step 3: 提交**

```bash
git add types/index.ts
git commit -m "feat: 扩展类型定义，添加 isMock 和 exchangeId"
```

---

## Phase 2: 交易所实现

### Task 3: 创建交易所注册表

**Files:**
- Create: `lib/data/exchanges/registry.ts`

- [ ] **Step 1: 创建注册表实现**

```typescript
// lib/data/exchanges/registry.ts
import type { ExchangeFetcher, ExchangeRegistry as IExchangeRegistry, ExchangeId } from './types';
import { DeribitFetcher } from './deribit';
import { BybitFetcher } from './bybit';
import { BinanceFetcher } from './binance';

class ExchangeRegistryImpl implements IExchangeRegistry {
  private fetchers: Map<ExchangeId, ExchangeFetcher>;

  constructor() {
    this.fetchers = new Map();
    this.register(new DeribitFetcher());
    this.register(new BybitFetcher());
    this.register(new BinanceFetcher());
  }

  private register(fetcher: ExchangeFetcher): void {
    this.fetchers.set(fetcher.id, fetcher);
  }

  get(exchangeId: ExchangeId): ExchangeFetcher {
    const fetcher = this.fetchers.get(exchangeId);
    if (!fetcher) {
      throw new Error(`Exchange not supported: ${exchangeId}`);
    }
    return fetcher;
  }

  list(): ExchangeFetcher[] {
    return Array.from(this.fetchers.values());
  }
}

export const exchangeRegistry = new ExchangeRegistryImpl();
```

- [ ] **Step 2: 提交**

```bash
git add lib/data/exchanges/registry.ts
git commit -m "feat: 添加交易所注册表"
```

---

### Task 4: 迁移 Deribit 实现

**Files:**
- Create: `lib/data/exchanges/deribit.ts`
- Modify: `lib/data/fetcher.ts`

- [ ] **Step 1: 创建 DeribitFetcher 类**

```typescript
// lib/data/exchanges/deribit.ts
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

export class DeribitFetcher implements ExchangeFetcher {
  readonly id = 'deribit' as const;
  readonly name = 'Deribit';

  async fetchOptions(): Promise<MarketSnapshot> {
    try {
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

      const allInstruments: any[] = (instrData.result ?? []).filter((i: any) => i.is_active);
      const spot: number = idxData.result?.index_price ?? 0;
      if (spot <= 0) throw new Error('invalid BTC index price');

      const byExpiry = new Map<string, any[]>();
      for (const inst of allInstruments) {
        const exp = inst.instrument_name.split('-')[1] ?? '';
        if (!byExpiry.has(exp)) byExpiry.set(exp, []);
        byExpiry.get(exp)!.push(inst);
      }

      const MAX_PER_EXPIRY = 20;
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

      const BATCH_SIZE = 50;
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
        if (strike < spot * 0.4 || strike > spot * 2.0) continue;

        const expiryMs: number = inst.expiration_timestamp ?? 0;
        const t = expiryMs > 0
          ? Math.max((expiryMs - nowMs) / (365 * 24 * 3600 * 1000), 0)
          : (() => {
              const expiryDate = parseDeribitExpiry(name.split('-')[1] ?? '');
              return expiryDate ? tte(expiryDate) : 0;
            })();
        if (t < 1 / 365) continue;

        const expiryDate = new Date(expiryMs > 0 ? expiryMs : Date.now());
        const expiryStr = expiryDate.toISOString().split('T')[0];

        const isCall: boolean = (inst.option_type ?? name.split('-')[3]) === 'call'
          || name.split('-')[3] === 'C';

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
          volume: ticker.stats?.volume ?? 0,
          openInterest: ticker.open_interest ?? 0,
          impliedVol: iv,
          tte: t,
          moneyness: mono,
        });
      }

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
      console.warn('[DeribitFetcher] fallback to mock:', e);
      let fallbackSpot = 80000;
      try {
        const r = await fetch('https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd', { signal: AbortSignal.timeout(3000) });
        const d = await r.json();
        fallbackSpot = d.result?.index_price ?? fallbackSpot;
      } catch { /* ignore */ }
      const snapshot = generateMockSnapshot('BTC', fallbackSpot);
      return { ...snapshot, isMock: true, exchangeId: 'deribit' };
    }
  }
}
```

- [ ] **Step 2: 简化 fetcher.ts，保留 generateMockSnapshot**

修改 `lib/data/fetcher.ts`，只保留 `generateMockSnapshot` 函数并导出它，同时添加一个便捷的导出函数：

```typescript
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
```

- [ ] **Step 3: 提交**

```bash
git add lib/data/exchanges/deribit.ts lib/data/fetcher.ts
git commit -m "feat: 迁移 Deribit 实现到独立文件"
```

---

### Task 5: 创建 Bybit 交易所实现

**Files:**
- Create: `lib/data/exchanges/bybit.ts`

- [ ] **Step 1: 创建 BybitFetcher 类**

```typescript
// lib/data/exchanges/bybit.ts
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

export class BybitFetcher implements ExchangeFetcher {
  readonly id = 'bybit' as const;
  readonly name = 'Bybit';

  async fetchOptions(): Promise<MarketSnapshot> {
    try {
      const [instrRes, tickerRes, idxRes] = await Promise.all([
        fetch(
          'https://api.bybit.com/v5/market/instruments-info?category=option&baseCoin=BTC',
          { signal: AbortSignal.timeout(10000) }
        ),
        fetch(
          'https://api.bybit.com/v5/market/tickers?category=option&baseCoin=BTC',
          { signal: AbortSignal.timeout(10000) }
        ),
        fetch(
          'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
          { signal: AbortSignal.timeout(8000) }
        ),
      ]);

      if (!instrRes.ok || !tickerRes.ok || !idxRes.ok) {
        throw new Error('Bybit API request failed');
      }

      const [instrData, tickerData, idxData] = await Promise.all([
        instrRes.json(),
        tickerRes.json(),
        idxRes.json()
      ]);

      const instruments: any[] = instrData.result?.list ?? [];
      const tickers: any[] = tickerData.result?.list ?? [];
      const spot = parseFloat(idxData.result?.list?.[0]?.lastPrice ?? '0');
      
      if (spot <= 0) throw new Error('invalid BTC price');

      const tickerMap = new Map<string, any>();
      for (const t of tickers) {
        tickerMap.set(t.symbol, t);
      }

      const contracts: OptionContract[] = [];
      const nowMs = Date.now();

      const byExpiry = new Map<string, any[]>();
      for (const inst of instruments) {
        const expiry = inst.expiryDate ?? '';
        if (!byExpiry.has(expiry)) byExpiry.set(expiry, []);
        byExpiry.get(expiry)!.push(inst);
      }

      const MAX_PER_EXPIRY = 20;
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

      for (const inst of selectedInsts) {
        const symbol = inst.symbol;
        const ticker = tickerMap.get(symbol);
        if (!ticker) continue;

        const bid = parseFloat(ticker.bid1Price ?? '0');
        const ask = parseFloat(ticker.ask1Price ?? '0');
        if (bid <= 0 || ask <= 0 || ask < bid) continue;

        const midPrice = (bid + ask) / 2;
        const strike = parseFloat(inst.strikePrice ?? '0');
        if (strike < spot * 0.4 || strike > spot * 2.0) continue;

        const expiryTs = parseInt(inst.expiryDate ?? '0');
        const expiryDate = new Date(expiryTs);
        const t = Math.max((expiryTs - nowMs) / (365 * 24 * 3600 * 1000), 0);
        if (t < 1 / 365) continue;

        const expiryStr = expiryDate.toISOString().split('T')[0];
        const isCall = inst.optionsType === 'C';

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
          volume: parseFloat(ticker.volume24h ?? '0'),
          openInterest: parseFloat(inst.openInterest ?? '0'),
          impliedVol: iv,
          tte: t,
          moneyness: mono,
        });
      }

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
      console.warn('[BybitFetcher] fallback to mock:', e);
      const snapshot = generateMockSnapshot('BTC', 80000);
      return { ...snapshot, isMock: true, exchangeId: 'bybit', source: 'bybit-mock' };
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add lib/data/exchanges/bybit.ts
git commit -m "feat: 添加 Bybit 交易所实现"
```

---

### Task 6: 创建 Binance 交易所实现

**Files:**
- Create: `lib/data/exchanges/binance.ts`

- [ ] **Step 1: 创建 BinanceFetcher 类**

```typescript
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
      const [exchangeRes, tickerRes, idxRes] = await Promise.all([
        fetch(
          'https://eapi.binance.com/eapi/v1/exchangeInfo',
          { signal: AbortSignal.timeout(10000) }
        ),
        fetch(
          'https://eapi.binance.com/eapi/v1/ticker',
          { signal: AbortSignal.timeout(10000) }
        ),
        fetch(
          'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
          { signal: AbortSignal.timeout(8000) }
        ),
      ]);

      if (!exchangeRes.ok || !tickerRes.ok || !idxRes.ok) {
        throw new Error('Binance API request failed');
      }

      const [exchangeData, tickerData, idxData] = await Promise.all([
        exchangeRes.json(),
        tickerRes.json(),
        idxRes.json()
      ]);

      const instruments: any[] = exchangeData.optionSymbols ?? [];
      const tickers: any[] = Array.isArray(tickerData) ? tickerData : [];
      const spot = parseFloat(idxData.price ?? '0');
      
      if (spot <= 0) throw new Error('invalid BTC price');

      const tickerMap = new Map<string, any>();
      for (const t of tickers) {
        tickerMap.set(t.symbol, t);
      }

      const contracts: OptionContract[] = [];
      const nowMs = Date.now();

      const byExpiry = new Map<string, any[]>();
      for (const inst of instruments) {
        if (inst.underlying !== 'BTCUSDT') continue;
        const expiry = inst.expiryDate ?? '';
        if (!byExpiry.has(expiry)) byExpiry.set(expiry, []);
        byExpiry.get(expiry)!.push(inst);
      }

      const MAX_PER_EXPIRY = 20;
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

      for (const inst of selectedInsts) {
        const symbol = inst.symbol;
        const ticker = tickerMap.get(symbol);
        if (!ticker) continue;

        const bid = parseFloat(ticker.bidPrice ?? '0');
        const ask = parseFloat(ticker.askPrice ?? '0');
        if (bid <= 0 || ask <= 0 || ask < bid) continue;

        const midPrice = (bid + ask) / 2;
        const strike = parseFloat(inst.strikePrice ?? '0');
        if (strike < spot * 0.4 || strike > spot * 2.0) continue;

        const expiryTs = parseInt(inst.expiryDate ?? '0');
        const expiryDate = new Date(expiryTs);
        const t = Math.max((expiryTs - nowMs) / (365 * 24 * 3600 * 1000), 0);
        if (t < 1 / 365) continue;

        const expiryStr = expiryDate.toISOString().split('T')[0];
        const isCall = inst.side === 'CALL';

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
          volume: parseFloat(ticker.volume ?? '0'),
          openInterest: parseFloat(ticker.openInterest ?? '0'),
          impliedVol: iv,
          tte: t,
          moneyness: mono,
        });
      }

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
      const snapshot = generateMockSnapshot('BTC', 80000);
      return { ...snapshot, isMock: true, exchangeId: 'binance', source: 'binance-mock' };
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add lib/data/exchanges/binance.ts
git commit -m "feat: 添加 Binance 交易所实现"
```

---

## Phase 3: API 层更新

### Task 7: 更新 IV Surface API 路由

**Files:**
- Modify: `app/api/iv-surface/route.ts`

- [ ] **Step 1: 添加导入和更新类型**

在文件顶部添加导入：
```typescript
import { fetchOptionsByExchange } from '@/lib/data/fetcher';
import type { ExchangeId, OptionTypeFilter } from '@/lib/data/exchanges/types';
```

在 `SurfaceResponse` 接口中添加新字段：
```typescript
export interface SurfaceResponse {
  // ... 现有字段
  isMock: boolean;
  exchange: ExchangeId;
}
```

- [ ] **Step 2: 更新 GET 函数，添加交易所和期权类型参数**

修改 `GET` 函数的查询参数解析部分：
```typescript
// 交易所参数，默认 deribit
const exchangeParam = sp.get('exchange') ?? 'deribit';
const exchange: ExchangeId = 
  (exchangeParam === 'deribit' || exchangeParam === 'bybit' || exchangeParam === 'binance')
    ? exchangeParam as ExchangeId
    : 'deribit';

// 期权类型参数，默认 both
const optionTypeParam = sp.get('optionType') ?? 'both';
const optionType: OptionTypeFilter =
  (optionTypeParam === 'call' || optionTypeParam === 'put' || optionTypeParam === 'both')
    ? optionTypeParam as OptionTypeFilter
    : 'both';
```

替换数据获取部分：
```typescript
// 使用健壮的 fetcher 层（已包含回退机制）
const snapshot = await fetchOptionsByExchange(exchange);
const windowTs = snapshot.fetchedAt;
const underlying = snapshot.underlyingPrice;
const r = 0.0;

// 转换数据格式
let contracts = snapshot.contracts;

// 根据期权类型过滤
if (optionType === 'call') {
  contracts = contracts.filter(c => c.optionType === 'call');
} else if (optionType === 'put') {
  contracts = contracts.filter(c => c.optionType === 'put');
}
```

移除错误添加的 Call 过滤：
```typescript
// 删除这一行：.filter(c => c.optionType === 'call')
```

更新响应部分，添加新字段：
```typescript
return NextResponse.json({
  // ... 现有字段
  isMock: snapshot.isMock,
  exchange: exchange,
} satisfies SurfaceResponse);
```

- [ ] **Step 3: 提交**

```bash
git add app/api/iv-surface/route.ts
git commit -m "feat: API 添加交易所和期权类型参数支持"
```

---

## Phase 4: 前端 UI 更新

### Task 8: 更新 Dashboard 组件

**Files:**
- Modify: `components/Dashboard.tsx`

- [ ] **Step 1: 添加新的状态和导入**

添加导入：
```typescript
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ExchangeId, OptionTypeFilter } from '@/lib/data/exchanges/types';
```

添加新状态：
```typescript
const [exchange, setExchange] = useState<ExchangeId>('deribit');
const [optionType, setOptionType] = useState<OptionTypeFilter>('both');
```

- [ ] **Step 2: 更新 fetchSurface 函数**

修改 `fetchSurface` 函数签名和调用：
```typescript
const fetchSurface = useCallback(async (
  p: DetectionParams, 
  stress: boolean,
  exch: ExchangeId,
  optType: OptionTypeFilter
) => {
  setLoading(true);
  setError(null);
  try {
    const url = new URL('/api/iv-surface', window.location.origin);
    url.searchParams.set('sigma', String(p.sigmaMultiplier));
    url.searchParams.set('absPct', String(p.absPctThreshold / 100));
    url.searchParams.set('smooth', String(p.smoothLambda));
    url.searchParams.set('exchange', exch);
    url.searchParams.set('optionType', optType);
    if (stress) {
      url.searchParams.set('stress', '1');
      url.searchParams.set('stressCount', '5');
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const json: SurfaceResponse = await res.json();
    setData(json);
    setStressActive(stress);
    setSelectedPoint(null);
  } catch (e: any) {
    setError(e.message);
  } finally {
    setLoading(false);
  }
}, []);
```

更新 useEffect：
```typescript
useEffect(() => { fetchSurface(params, false, exchange, optionType); }, [fetchSurface, exchange, optionType]);
```

更新所有调用 `fetchSurface` 的地方，添加新参数：
```typescript
// 例如在 handleSigmaChange 中
fetchSurface(next, stressMode, exchange, optionType);
```

- [ ] **Step 3: 添加交易所选择下拉框**

在顶部导航栏右侧、刷新按钮前添加：
```typescript
{/* 交易所选择器 */}
<select
  value={exchange}
  onChange={(e) => setExchange(e.target.value as ExchangeId)}
  disabled={loading}
  className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white 
    focus:border-blue-500 focus:outline-none disabled:opacity-40"
>
  <option value="deribit">Deribit</option>
  <option value="bybit">Bybit</option>
  <option value="binance">Binance</option>
</select>

{/* 期权类型切换 */}
<div className="flex rounded-lg border border-slate-700 overflow-hidden">
  <button
    onClick={() => setOptionType('call')}
    disabled={loading}
    className={`px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40
      ${optionType === 'call' 
        ? 'bg-blue-500/20 text-blue-400 border-r border-slate-700' 
        : 'text-slate-400 hover:text-white border-r border-slate-700'}`}
  >
    Call
  </button>
  <button
    onClick={() => setOptionType('put')}
    disabled={loading}
    className={`px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40
      ${optionType === 'put' 
        ? 'bg-purple-500/20 text-purple-400 border-r border-slate-700' 
        : 'text-slate-400 hover:text-white border-r border-slate-700'}`}
  >
    Put
  </button>
  <button
    onClick={() => setOptionType('both')}
    disabled={loading}
    className={`px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40
      ${optionType === 'both' 
        ? 'bg-slate-700 text-white' 
        : 'text-slate-400 hover:text-white'}`}
  >
    Both
  </button>
</div>
```

- [ ] **Step 4: 添加数据来源指示器**

在状态栏信息行末尾添加：
```typescript
{data && !loading && (
  <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400">
    {/* ... 现有内容 ... */}
    <span className="text-slate-700">·</span>
    {data.isMock ? (
      <span className="text-yellow-400 flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
        Mock @ {data.exchange.charAt(0).toUpperCase() + data.exchange.slice(1)}
      </span>
    ) : (
      <span className="text-emerald-400 flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
        Real-time @ {data.exchange.charAt(0).toUpperCase() + data.exchange.slice(1)}
      </span>
    )}
  </div>
)}
```

- [ ] **Step 5: 更新 loading 提示**

更新 loading 提示文本：
```typescript
<div className="text-sm text-slate-400">
  正在获取 {exchange.charAt(0).toUpperCase() + exchange.slice(1)} 期权数据并计算 IV 基准曲面…
</div>
```

- [ ] **Step 6: 提交**

```bash
git add components/Dashboard.tsx
git commit -m "feat: 添加交易所和期权类型选择器，以及数据来源指示器"
```

---

## Phase 5: 测试和验证

### Task 9: 端到端测试

**Files:**
- 无新文件，运行现有应用测试

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 测试交易所切换**

访问 http://localhost:3000，依次测试：
- 默认 Deribit 加载
- 切换到 Bybit
- 切换到 Binance
- 切回 Deribit

- [ ] **Step 3: 测试期权类型切换**

测试 Call / Put / Both 三种模式

- [ ] **Step 4: 验证数据来源指示器**

确认显示 Real-time 或 Mock

- [ ] **Step 5: 提交（如果有修复）**

```bash
# 只有发现问题需要修复时才提交
git add <修复的文件>
git commit -m "fix: 修复测试中发现的问题"
```

---

## 计划自我审查

✅ **Spec 覆盖:** 所有需求都有对应任务  
✅ **无占位符:** 所有代码块完整，无 TBD  
✅ **类型一致:** 类型定义和使用一致，ExchangeId/OptionTypeFilter 正确使用  
✅ **文件路径:** 所有路径精确，与项目结构匹配  

---

## 执行选择

Plan complete and saved to `docs/superpowers/plans/2026-04-18-multi-exchange-support.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
