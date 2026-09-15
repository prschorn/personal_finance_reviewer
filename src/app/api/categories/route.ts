import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { bootstrap } from '../../../db/bootstrap';
import { categories } from '../../../db/schema';

export const dynamic = 'force-dynamic';

export function GET() {
  const db = bootstrap(getDb());
  const rows = db
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(eq(categories.archived, false))
    .orderBy(asc(categories.sortOrder))
    .all();
  return NextResponse.json(rows);
}
