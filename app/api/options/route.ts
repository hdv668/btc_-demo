import { NextRequest, NextResponse } from 'next/server';
import { fetchBTCOptions, fetchStockOptions } from '@/lib/data/fetcher';
import { analyseSnapshot } from '@/lib/signals/detector';

export const runtime = 'nodejs';
export const maxDuration = 30;

// BTC + 美股市值前10（MSFT/AAPL/NVDA/AMZN/GOOGL/META/TSLA/BRK.B→用BRK-B/JPM/V）
const SUPPORTED_SYMBOLS = [
  'BTC',
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK-B', 'JPM', 'V',
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? 'BTC').toUpperCase();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    return NextResponse.json({ error: `Unsupported symbol: ${symbol}` }, { status: 400 });
  }

  try {
    const snapshot = symbol === 'BTC'
      ? await fetchBTCOptions()
      : await fetchStockOptions(symbol);

    const analysis = analyseSnapshot(snapshot);
    return NextResponse.json(analysis);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
