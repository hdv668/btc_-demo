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
