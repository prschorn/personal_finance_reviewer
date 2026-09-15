import { NextResponse } from 'next/server';
import { getDb } from '../../../db/client';
import { bootstrap } from '../../../db/bootstrap';
import { getCommittedTransactions } from '../../../queries/today';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const month = new URL(request.url).searchParams.get('month');

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 });
  }

  const db = bootstrap(getDb());
  return NextResponse.json(getCommittedTransactions(db, { month }));
}
