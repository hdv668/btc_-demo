import { HttpsProxyAgent } from 'https-proxy-agent';
import axios from 'axios';

export interface OptionSummary {
  instrument_name: string;
  bid_price: number;
  ask_price: number;
  underlying_price?: number;
}

export interface ExchangeAdapter {
  name: string;
  fetchOptions: (proxyUrl: string | null) => Promise<{
    result: OptionSummary[];
    indexPrice: number;
    fetchedAt: number;
  }>;
  parseInstrumentName: (name: string) => {
    expiryStr: string;
    strike: number;
    optionType: 'C' | 'P';
  } | null;
  parseExpiry: (expiryStr: string, fetchedAt: number) => Date | null;
  // 价格是否以 BTC 计价（true）还是 USD 计价（false）
  priceInBTC: boolean;
}

// ─── Deribit 适配器 ──────────────────────────────────────────────────────
export const deribitAdapter: ExchangeAdapter = {
  name: 'deribit',
  priceInBTC: true,

  async fetchOptions(proxyUrl: string | null) {
    const fetchedAt = Date.now();
    const axiosConfig: any = { timeout: 20000 };

    if (proxyUrl && typeof process !== 'undefined' && process.versions?.node) {
      const agent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
      axiosConfig.proxy = false;
    }

    const [bookRes, idxRes] = await Promise.all([
      axios.get(
        'https://deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
        axiosConfig
      ),
      axios.get(
        'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd',
        axiosConfig
      ),
    ]);

    if (bookRes.status !== 200) throw new Error(`Deribit error: ${bookRes.status}`);
    const indexPrice: number = idxRes.data.result?.index_price ?? 0;
    return { result: bookRes.data.result ?? [], indexPrice, fetchedAt };
  },

  parseInstrumentName(name: string) {
    const parts = name.split('-');
    if (parts.length !== 4) return null;
    const [, expiryStr, strikeStr, optionType] = parts;
    if (optionType !== 'C' && optionType !== 'P') return null;
    return { expiryStr, strike: parseFloat(strikeStr), optionType: optionType as 'C' | 'P' };
  },

  parseExpiry(expiryStr: string, fetchedAt: number) {
    let expiry: Date;
    try {
      expiry = new Date(`${expiryStr.slice(0, -2)} 20${expiryStr.slice(-2)} 08:00:00 UTC`);
      if (isNaN(expiry.getTime())) {
        const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
        const day = parseInt(expiryStr.replace(/[A-Z]/g, ''));
        const monStr = expiryStr.slice(-5, -2).toUpperCase();
        const yr = 2000 + parseInt(expiryStr.slice(-2));
        expiry = new Date(Date.UTC(yr, months[monStr], day, 8, 0, 0));
      }
    } catch {
      return null;
    }
    return isNaN(expiry.getTime()) ? null : expiry;
  }
};

// ─── Bybit 适配器 ──────────────────────────────────────────────────────
export const bybitAdapter: ExchangeAdapter = {
  name: 'bybit',
  priceInBTC: false, // Bybit 期权价格以 USD 计价

  async fetchOptions(proxyUrl: string | null) {
    const fetchedAt = Date.now();
    const axiosConfig: any = { timeout: 20000 };

    if (proxyUrl && typeof process !== 'undefined' && process.versions?.node) {
      const agent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
      axiosConfig.proxy = false;
    }

    // Bybit API: 获取期权订单簿摘要
    const [tickerRes, idxRes] = await Promise.all([
      axios.get(
        'https://api.bybit.com/v5/market/tickers?category=option&baseCoin=BTC',
        axiosConfig
      ),
      axios.get(
        'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
        axiosConfig
      ),
    ]);

    if (tickerRes.status !== 200) throw new Error(`Bybit error: ${tickerRes.status}`);

    // 转换 Bybit 数据格式为统一格式
    const bybitTickers = tickerRes.data.result?.list ?? [];
    const result: OptionSummary[] = bybitTickers.map((ticker: any) => ({
      instrument_name: ticker.symbol,
      bid_price: parseFloat(ticker.bid1Price) || 0,
      ask_price: parseFloat(ticker.ask1Price) || 0,
    }));

    const indexPrice = parseFloat(idxRes.data.result?.list?.[0]?.lastPrice) || 0;
    return { result, indexPrice, fetchedAt };
  },

  parseInstrumentName(name: string) {
    // Bybit 期权命名格式: BTC-25SEP26-63000-C-USDT (5个部分)
    const parts = name.split('-');
    if (parts.length !== 5) {
      return null;
    }
    const [, expiryStr, strikeStr, optionType] = parts;
    if (optionType !== 'C' && optionType !== 'P') return null;
    return { expiryStr, strike: parseFloat(strikeStr), optionType: optionType as 'C' | 'P' };
  },

  parseExpiry(expiryStr: string, fetchedAt: number) {
    // Bybit 格式: 10JAN25
    try {
      const months: Record<string, number> = {
        'JAN': 0, 'FEB': 1, 'MAR': 2, 'APR': 3, 'MAY': 4, 'JUN': 5,
        'JUL': 6, 'AUG': 7, 'SEP': 8, 'OCT': 9, 'NOV': 10, 'DEC': 11
      };

      const day = parseInt(expiryStr.slice(0, 2));
      const monStr = expiryStr.slice(2, 5).toUpperCase();
      const yr = 2000 + parseInt(expiryStr.slice(5, 7));

      const expiry = new Date(Date.UTC(yr, months[monStr], day, 8, 0, 0));
      return isNaN(expiry.getTime()) ? null : expiry;
    } catch {
      return null;
    }
  }
};

export function getExchangeAdapter(exchange: string): ExchangeAdapter {
  switch (exchange) {
    case 'bybit':
      return bybitAdapter;
    case 'deribit':
    default:
      return deribitAdapter;
  }
}
