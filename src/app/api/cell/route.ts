import { NextResponse } from 'next/server';
import { getDb } from '../../../db/client';
import { bootstrap } from '../../../db/bootstrap';
import { getCellTransactions } from '../../../queries/matrix';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month');
  const categoryId = Number(url.searchParams.get('categoryId'));

  if (!month || !/^\d{4}-\d{2}$/.test(month) || !Number.isInteger(categoryId)) {
    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 });
  }

  const db = bootstrap(getDb());
  return NextResponse.json(getCellTransactions(db, { month, categoryId }));
}
