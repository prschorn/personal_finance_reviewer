import { NextResponse } from 'next/server';
import { getDb } from '../../../db/client';
import { bootstrap } from '../../../db/bootstrap';
import { getCardCategoryTransactions } from '../../../queries/cards';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const url = new URL(request.url);
  const year = Number(url.searchParams.get('year'));
  const month = url.searchParams.get('month');
  const rawCategory = url.searchParams.get('categoryId');

  if (!Number.isInteger(year)) {
    return NextResponse.json({ error: 'Ano inválido' }, { status: 400 });
  }
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'Mês inválido' }, { status: 400 });
  }

  // An absent categoryId means the "Sem categoria" row, which is a real selection
  // rather than a missing parameter.
  const categoryId = rawCategory === null || rawCategory === '' ? null : Number(rawCategory);
  if (categoryId !== null && !Number.isInteger(categoryId)) {
    return NextResponse.json({ error: 'Categoria inválida' }, { status: 400 });
  }

  const db = bootstrap(getDb());
  return NextResponse.json(
    getCardCategoryTransactions(db, { year, month: month ?? undefined, categoryId }),
  );
}
