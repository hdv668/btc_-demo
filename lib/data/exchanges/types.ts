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
