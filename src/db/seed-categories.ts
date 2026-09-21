import { eq } from 'drizzle-orm';
import { getDb, type DB } from './client';
import { categories } from './schema';

export type CategoryKind = 'expense' | 'income' | 'internal';

interface SeedCategory {
  name: string;
  kind: CategoryKind;
}

/**
 * Seeded from the rows of the "Planilha orçamento" Numbers sheet, in sheet order.
 *
 * Two rows from the original sheet are deliberately absent: "Itaú" and "Nubank".
 * Those were whole-credit-card-bill lines; this app itemizes card purchases into
 * the categories below instead, and treats the bill payment as an internal
 * transfer. Keeping them would double-count every card purchase.
 */
export const SEED_CATEGORIES: SeedCategory[] = [
  // Despesas, in spreadsheet order
  { name: 'Condomínio', kind: 'expense' },
  { name: 'Apartamento', kind: 'expense' },
  { name: 'Luz', kind: 'expense' },
  { name: 'Bateria', kind: 'expense' },
  { name: 'Celular', kind: 'expense' },
  { name: 'Internet', kind: 'expense' },
  { name: 'Nutricionista', kind: 'expense' },
  { name: 'Bruno', kind: 'expense' },
  { name: 'Marmitas', kind: 'expense' },
  
  { name: 'Psiquiatra', kind: 'expense' },
  { name: 'Saúde', kind: 'expense' },
  { name: 'Compras', kind: 'expense' },
  { name: 'Restaurante', kind: 'expense' },
  { name: 'Mercado', kind: 'expense' },
  { name: 'Viagem', kind: 'expense' },
  { name: 'Farmácia', kind: 'expense' },
  { name: 'IPVA', kind: 'expense' },
  { name: 'Carro', kind: 'expense' },
  { name: 'DAS', kind: 'expense' },
  { name: 'DARF', kind: 'expense' },
  { name: 'Manutenção', kind: 'expense' },
  { name: 'IPTU', kind: 'expense' },
  { name: 'Taxas', kind: 'expense' },
  { name: 'Imposto', kind: 'expense' },

  // Added by this app
  { name: 'Outros', kind: 'expense' }, // default bucket for unmatched money-out

  // Income. `PJ` is the spreadsheet's word for consultancy revenue.
  { name: 'PJ', kind: 'income' },
  { name: 'Receitas', kind: 'income' },

  { name: 'Transferências internas', kind: 'internal' },
];

/** Names the rest of the app refers to by constant rather than by literal. */
export const CATEGORY_OUTROS = 'Outros';
export const CATEGORY_RECEITAS = 'Receitas';
export const CATEGORY_INTERNAL = 'Transferências internas';
export const CATEGORY_DINHEIRO = 'Dinheiro';
export const CATEGORY_PJ = 'PJ';

/**
 * Idempotent: inserts anything missing, leaves existing rows (and any categories
 * the user added by hand) untouched.
 */
export function seedCategories(db: DB = getDb()): number {
  let inserted = 0;
  db.transaction((tx) => {
    SEED_CATEGORIES.forEach((c, i) => {
      const existing = tx.select().from(categories).where(eq(categories.name, c.name)).get();
      if (existing) return;
      tx.insert(categories).values({ name: c.name, kind: c.kind, sortOrder: i * 10 }).run();
      inserted++;
    });
  });
  return inserted;
}
