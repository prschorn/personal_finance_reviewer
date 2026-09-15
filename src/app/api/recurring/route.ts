import { NextResponse } from 'next/server';
import { getDb } from '../../../db/client';
import { bootstrap } from '../../../db/bootstrap';
import { getSeriesTransactions } from '../../../queries/recurring';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');

  if (!key) {
    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 });
  }

  const db = bootstrap(getDb());
  return NextResponse.json(getSeriesTransactions(db, { key }));
}
