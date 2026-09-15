import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { categories, rules } from '../db/schema';

/**
 * Starter categorization rules for Brazilian bank and card descriptions.
 *
 * Authored as a plain array rather than built through a CRUD screen: typing 40
 * rules here takes minutes, and the /rules page can start read-only.
 *
 * PRIORITY MATTERS. Lower runs first, and the first match wins. Two ordering
 * traps are already handled below:
 *   - "MERCADO LIVRE" must beat "MERCADO", or every Mercado Livre order is filed
 *     as groceries.
 *   - Internal movements must beat everything, or a card bill payment is counted
 *     as spending on top of the purchases it settles.
 *
 * Every rule is a starting point, not a truth. Expect to correct some from the
 * review queue — that is the intended workflow.
 */

export interface SeedRule {
  priority: number;
  name: string;
  /** Category name as seeded in db/seed-categories.ts. Omit when only setting internal. */
  category?: string;
  matchValue: string;
  matchType?: 'contains' | 'equals' | 'startsWith' | 'regex';
  matchField?: 'search_text' | 'description' | 'description_raw' | 'merchant_name';
  accountType?: 'BANK' | 'CREDIT';
  direction?: 'in' | 'out';
  setInternal?: boolean;
}

export const SEED_RULES: SeedRule[] = [
  // -- 10-29: internal movements. These MUST win over everything else. ------
  { priority: 10, name: 'Pagamento de fatura (banco)', matchType: 'regex', matchValue: '(PAGAMENTO|PAGTO|PGTO).*(FATURA|CARTAO)', setInternal: true },
  { priority: 11, name: 'Pagamento de fatura (cartão)', matchType: 'regex', matchValue: '^(PAGAMENTO|PAGTO|PGTO)', accountType: 'CREDIT', direction: 'in', setInternal: true },
  { priority: 12, name: 'Aplicação / resgate', matchType: 'regex', matchValue: '\\b(APLICAC|APLIC AUT|RESGATE|REDEEM)', setInternal: true },
  { priority: 13, name: 'Investimentos', matchType: 'regex', matchValue: '\\b(CDB|TESOURO DIRETO|RENDA FIXA|POUPANCA|FUNDO DE INVEST)\\b', setInternal: true },

  // -- 30-49: taxes and fees, before anything generic can claim them --------
  { priority: 30, name: 'DAS', category: 'DAS', matchType: 'regex', matchValue: '\\b(DAS|SIMPLES NACIONAL)\\b' },
  { priority: 31, name: 'DARF', category: 'DARF', matchType: 'regex', matchValue: '\\bDARF\\b' },
  { priority: 32, name: 'IPTU', category: 'IPTU', matchValue: 'IPTU' },
  { priority: 33, name: 'IPVA', category: 'IPVA', matchType: 'regex', matchValue: '\\b(IPVA|LICENCIAMENTO|DETRAN)\\b' },
  { priority: 34, name: 'Tarifas bancárias', category: 'Taxas', matchType: 'regex', matchValue: '\\b(IOF)\\b|\\b(TARIFA|ANUIDADE|JUROS|MULTA|ENCARGOS)' },
  { priority: 35, name: 'Saque', category: 'Dinheiro', matchType: 'regex', matchValue: '\\bSAQUE\\b' },

  // -- 50-69: recurring, named counterparties ------------------------------
  { priority: 50, name: 'Condomínio', category: 'Condomínio', matchValue: 'CONDOMINIO' },
  { priority: 51, name: 'Unimed', category: 'Unimed', matchValue: 'UNIMED' },
  { priority: 52, name: 'Energia elétrica', category: 'Luz', matchType: 'regex', matchValue: '\\b(ENEL|LIGHT SERVICOS|CEMIG|COPEL|CPFL|ELETROPAULO|CELESC|CEEE|NEOENERGIA|EQUATORIAL)\\b' },
  { priority: 53, name: 'Telefonia', category: 'Celular', matchType: 'regex', matchValue: '\\b(VIVO|CLARO|TIM BRASIL|TIM S|OI MOVEL|NEXTEL)\\b' },
  { priority: 54, name: 'Internet', category: 'Internet', matchType: 'regex', matchValue: '\\b(CLEAN NET)\\b' },
  { priority: 55, name: 'Marmitas', category: 'Marmitas', matchType: 'regex', matchValue: '\\b(MARMITA|LIVEFIT|LIVE FIT|FIT FOOD|LIGHT FOOD)' },

  // Ahead of everything else on the money-in side: this is the main income source,
  // and it should never be at the mercy of a generic transfer heuristic.
  { priority: 20, name: 'Receita PJ (Schorn Consultoria)', category: 'PJ', direction: 'in', matchValue: 'SCHORN CONSULTORIA' },

  { priority: 60, name: 'Salário e recebimentos', category: 'Receitas', direction: 'in', matchType: 'regex', matchValue: '\\b(SALARIO|PRO ?LABORE|REMUNERACAO|RENDIMENTO|PAGAMENTO DE CLIENTE)' },

  // -- 70-89: shopping. MERCADO LIVRE must precede the MERCADO rule. -------
  { priority: 70, name: 'Mercado Livre', category: 'Compras', matchType: 'regex', matchValue: 'MERCADO ?(LIVRE|PAGO)|MERCADOLIVRE|MERCADOPAGO' },
  { priority: 71, name: 'Marketplaces', category: 'Compras', matchType: 'regex', matchValue: '\\b(AMAZON|MAGAZINE LUIZA|MAGALU|AMERICANAS|SHOPEE|ALIEXPRESS|SHEIN|CASAS BAHIA)\\b' },
  { priority: 72, name: 'Vestuário e casa', category: 'Compras', matchType: 'regex', matchValue: '\\b(RENNER|RIACHUELO|C&A|ZARA|CENTAURO|NIKE|ADIDAS|IKEA|LEROY MERLIN|TOK STOK|MOBLY)\\b' },
  { priority: 73, name: 'Assinaturas digitais', category: 'Compras', matchType: 'regex', matchValue: '\\b(NETFLIX|SPOTIFY|DISNEY|HBO|MAX |PRIME VIDEO|APPLE ?COM|GOOGLE ONE|YOUTUBE PREMIUM|OPENAI|ANTHROPIC)\\b' },

  // -- 90-109: food -------------------------------------------------------
  { priority: 90, name: 'Delivery', category: 'Restaurante', matchType: 'regex', matchValue: '\\b(IFOOD|RAPPI|UBER ?EATS|ZE DELIVERY|AIQFOME)' },
  { priority: 91, name: 'Restaurantes e bares', category: 'Restaurante', matchType: 'regex', matchValue: '\\b(RESTAURANTE|BURGER|PIZZA|OUTBACK|MADERO|SUSHI|CHURRASC|BOTECO|CANTINA|TEMAKI)|\\bBAR\\b' },
  { priority: 92, name: 'Cafés e padarias', category: 'Restaurante', matchType: 'regex', matchValue: '\\b(STARBUCKS|CAFE|PADARIA|CONFEITARIA|DOCERIA)' },
  { priority: 100, name: 'Supermercados', category: 'Mercado', matchType: 'regex', matchValue: '\\b(PAO DE ACUCAR|CARREFOUR|ASSAI|ATACADAO|SONDA|ST ?MARCHE|HORTIFRUTI|ZONA SUL|MAMBO|OBA |SUPERMERCADO|MERCEARIA|EMPORIO|MINUTO PAO)' },
  { priority: 101, name: 'Mercado (genérico)', category: 'Mercado', matchType: 'regex', matchValue: '\\b(MERCADO|EXTRA SUPER)' },

  // -- 110-129: health ----------------------------------------------------
  { priority: 110, name: 'Farmácias', category: 'Farmácia', matchType: 'regex', matchValue: '\\b(DROGA|RAIA|PACHECO|PAGUE MENOS|FARMACIA|ONOFRE|VENANCIO|PANVEL)' },
  { priority: 111, name: 'Exames e hospitais', category: 'Saúde', matchType: 'regex', matchValue: '\\b(HOSPITAL|LABORATORIO|FLEURY|DASA|ALBERT EINSTEIN|SIRIO LIBANES|SABIN|DELBONI|CLINICA)' },
  { priority: 112, name: 'Nutricionista', category: 'Nutricionista', matchValue: 'NUTRI' },
  { priority: 113, name: 'Psiquiatra', category: 'Psiquiatra', matchType: 'regex', matchValue: '\\b(PSIQUIATR|PSICOLOG|PSICANAL)' },

  // -- 130-149: car and transport -----------------------------------------
  { priority: 130, name: 'Combustível', category: 'Carro', matchType: 'regex', matchValue: '\\b(POSTO|SHELL|IPIRANGA|PETROBRAS|BR MANIA|ALE COMBUST|COMBUSTIVEL)' },
  { priority: 131, name: 'Estacionamento e pedágio', category: 'Carro', matchType: 'regex', matchValue: '\\b(ESTACIONAMENTO|ESTAPAR|SEM PARAR|CONECTCAR|VELOE|PEDAGIO|AUTOPASS)|\\bZUL\\b' },
  { priority: 132, name: 'Aplicativos de transporte', category: 'Carro', matchType: 'regex', matchValue: '\\b(UBER|99 ?APP|99POP|CABIFY|TAXI)' },
  { priority: 133, name: 'Oficina e manutenção', category: 'Manutenção', matchType: 'regex', matchValue: '\\b(OFICINA|AUTO ?CENTER|PNEU|MECANIC|FUNILARIA|LAVA ?RAPIDO)' },

  // -- 150+: travel -------------------------------------------------------
  { priority: 150, name: 'Passagens aéreas', category: 'Viagem', matchType: 'regex', matchValue: '\\b(LATAM|GOL LINHAS|AZUL LINHAS|SMILES|DECOLAR|123MILHAS)' },
  { priority: 151, name: 'Hospedagem', category: 'Viagem', matchType: 'regex', matchValue: '\\b(AIRBNB|BOOKING|HOTEL|POUSADA|HURB)|\\bCVC\\b' },
];

export interface SeedRulesResult {
  inserted: number;
  skippedUnknownCategory: string[];
}

/**
 * Idempotent: matches on rule name, so re-running adds only what's new and never
 * clobbers a rule the user has edited.
 */
export function seedRules(db: DB = getDb()): SeedRulesResult {
  const byName = new Map(db.select().from(categories).all().map((c) => [c.name, c.id]));
  const result: SeedRulesResult = { inserted: 0, skippedUnknownCategory: [] };

  db.transaction((tx) => {
    for (const seed of SEED_RULES) {
      if (tx.select().from(rules).where(eq(rules.name, seed.name)).get()) continue;

      let categoryId: number | null = null;
      if (seed.category) {
        const id = byName.get(seed.category);
        if (id == null) {
          result.skippedUnknownCategory.push(`${seed.name} -> ${seed.category}`);
          continue;
        }
        categoryId = id;
      }

      tx.insert(rules)
        .values({
          priority: seed.priority,
          name: seed.name,
          matchField: seed.matchField ?? 'search_text',
          matchType: seed.matchType ?? 'contains',
          matchValue: seed.matchValue,
          accountType: seed.accountType ?? null,
          direction: seed.direction ?? null,
          setCategoryId: categoryId,
          setInternal: seed.setInternal ?? null,
        })
        .run();
      result.inserted++;
    }
  });

  return result;
}
