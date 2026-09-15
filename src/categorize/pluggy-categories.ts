/**
 * Pluggy's own classification, used as a HINT layer.
 *
 * The probe found it populated on ~98% of transactions on this account, which was
 * not expected — it is a paid add-on and the plan assumed it would be null. It is
 * genuinely useful, but it is generic (there is no Pluggy category that means
 * "Marmitas" or "DARF"), so it is consulted only AFTER local rules have had their
 * say and only BEFORE the Outros fallback. A hand-picked category always wins.
 */

/** Pluggy categories that mean "this money only moved between the user's own places". */
export const PLUGGY_INTERNAL_CATEGORIES: Record<string, string> = {
  'Credit card payment': 'card_payment',
  'Same person transfer': 'own_transfer',

  // Investment movement is not spending and not income — it is the same money
  // changing shape. Includes yield ("Proceeds interests and dividends"), which is
  // a deliberate choice: it keeps Saldo meaning "what my life cost versus what I
  // earned", rather than being flattered by portfolio returns.
  Investments: 'investment',
  'Fixed income': 'investment',
  'Proceeds interests and dividends': 'investment',
};

/**
 * Deliberately NOT in the list above: the generic "Transfers" category, and
 * "Transfer - PIX". PIX is the channel real income arrives on — excluding it would
 * erase the largest income source on the account. Ambiguous transfers stay visible
 * in the review queue instead of being guessed at.
 */

/**
 * Pluggy category -> the category name in db/seed-categories.ts.
 *
 * Only mappings that are unambiguous for this spreadsheet. Anything vague
 * ("Services", "Shopping", "Transfers", "Investments") is deliberately absent so
 * it surfaces in the review queue rather than being quietly filed somewhere
 * plausible but wrong.
 */
export const PLUGGY_CATEGORY_MAP: Record<string, string> = {
  // Food
  'Eating out': 'Restaurante',
  'Food delivery': 'Restaurante',
  Groceries: 'Mercado',

  // Transport
  'Taxi and ride-hailing': 'Carro',
  'Gas stations': 'Carro',
  Parking: 'Carro',
  'Tolls and in vehicle payment': 'Carro',
  Transportation: 'Carro',
  'Vehicle maintenance': 'Manutenção',
  'Vehicle ownership taxes and fees': 'IPVA',

  // Health
  Pharmacy: 'Farmácia',
  Healthcare: 'Saúde',
  'Hospital clinics and labs': 'Saúde',
  Dentist: 'Saúde',
  'Wellness and fitness': 'Saúde',
  'Gyms and fitness centers': 'Saúde',

  // Home and utilities
  Electricity: 'Luz',
  Rent: 'Apartamento',
  Housing: 'Apartamento',
  'Real estate financing': 'Apartamento',
  Telecommunications: 'Celular',
  Internet: 'Internet',

  // Travel
  'Airport and airlines': 'Viagem',
  Accomodation: 'Viagem',
  Travel: 'Viagem',
  'Mileage programs': 'Viagem',

  // Shopping and services
  'Online shopping': 'Compras',
  Clothing: 'Compras',
  'Sports goods': 'Compras',
  Houseware: 'Compras',
  Bookstore: 'Compras',
  'Digital services': 'Compras',
  'Video streaming': 'Compras',
  Gaming: 'Compras',
  'Office supplies': 'Compras',

  // Taxes and fees
  'Tax on financial operations': 'Taxas',
  'Late payment and overdraft costs': 'Taxas',
  'Taxes on investments': 'Imposto',
};

/**
 * Pluggy labels left deliberately unmapped, with the reason.
 *
 * Each of these is broad enough that a guess would hide real money in the wrong
 * row. They fall through to Outros and show up in the review queue, which is the
 * honest outcome: a visible gap beats a plausible lie.
 */
export const PLUGGY_CATEGORY_UNMAPPED: Record<string, string> = {
  Automotive: 'covers dealerships and vehicle purchase, not only servicing',
  Insurance: 'spans health, car, home and life',
  Services: 'too broad to place',
  Shopping: 'says nothing about what was bought',
  Transfers: 'may be your own money or someone else\'s',
  'Transfer - PIX': 'the channel income arrives on — never assume',
};
