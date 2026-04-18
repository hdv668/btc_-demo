import { NextRequest, NextResponse } from 'next/server';
import { fetchOptionsByExchange } from '@/lib/data/fetcher';
import type { ExchangeId } from '@/lib/data/exchanges/types';
import { analyseSnapshot } from '@/lib/signals/detector';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const exchangeParam = (searchParams.get('exchange') ?? 'deribit').toLowerCase();
  const exchange: ExchangeId =
    (exchangeParam === 'deribit' || exchangeParam === 'bybit' || exchangeParam === 'binance')
      ? exchangeParam as ExchangeId
      : 'deribit';

  try {
    const snapshot = await fetchOptionsByExchange(exchange);
    const analysis = analyseSnapshot(snapshot);
    return NextResponse.json(analysis);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
