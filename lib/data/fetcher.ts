// lib/data/fetcher.ts
// 服务器端专用 - 只包含服务器端需要的函数
import { exchangeRegistry } from './exchanges/registry';
import type { ExchangeId } from './exchanges/types';
import type { MarketSnapshot } from '@/types';

export async function fetchOptionsByExchange(exchangeId: ExchangeId): Promise<MarketSnapshot> {
  const fetcher = exchangeRegistry.get(exchangeId);
  return fetcher.fetchOptions();
}

export { fetchBTCOptions } from './exchanges/deribit';
