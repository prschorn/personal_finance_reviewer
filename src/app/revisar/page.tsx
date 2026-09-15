import Link from 'next/link';
import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { getReviewQueue, type ReviewItem, type ReviewKind } from '../../queries/review';
import { formatBRL } from '../../lib/money';
import { CategoryPicker } from '../_components/CategoryPicker';
import { ReviewActions } from '../_components/ReviewActions';

export const dynamic = 'force-dynamic';

const HEADINGS: Record<ReviewKind, { title: string; blurb: string }> = {
  duplicata: {
    title: 'Possíveis duplicatas',
    blurb: 'Lançamentos idênticos. Se for cobrança dupla, algum total está errado — por isso vêm primeiro.',
  },
  'valor-atipico': {
    title: 'Valores fora do normal',
    blurb: 'Muito acima do maior valor já gasto nesse lugar. Comparado com o máximo, não com a média.',
  },
  'sem-categoria': {
    title: 'Categoria que ninguém decidiu',
    blurb: 'A categoria veio de um palpite — do app ou da Pluggy — e não de uma regra sua. Escolher aqui cria a regra.',
  },
  'preco-mudou': {
    title: 'Mudaram de preço',
    blurb: 'Cobranças fixas que passaram a cobrar outro valor, e ficaram assim.',
  },
  'serie-parou': {
    title: 'Pararam de aparecer',
    blurb: 'Vinham todo mês e passaram um mês inteiro sem cobrar.',
  },
};

const ORDER: ReviewKind[] = ['duplicata', 'valor-atipico', 'sem-categoria', 'preco-mudou', 'serie-parou'];

function br(ymd: string) {
  return ymd.split('-').reverse().join('/');
}

function Group({ kind, items }: { kind: ReviewKind; items: ReviewItem[] }) {
  if (!items.length) return null;
  const { title, blurb } = HEADINGS[kind];

  return (
    <section>
      <h2 className="mb-1 font-serif text-xl">
        {title}
        <span className="tnum ml-2 text-[13px]" style={{ color: 'var(--ink-faint)' }}>
          {items.length}
        </span>
      </h2>
      <p className="mb-3 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        {blurb}
      </p>

      <table className="ledger w-full text-[13px]">
        <caption className="sr-only">{title}</caption>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <span className="block max-w-[30rem] truncate font-serif text-[15px]">{item.title}</span>
                <span className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                  {item.postedOn && <span className="tnum mr-2">{br(item.postedOn)}</span>}
                  {item.detail}
                </span>
                {item.fingerprint && kind === 'sem-categoria' && (
                  <span className="mt-1 block">
                    {/*
                      currentName is what makes the Confirmar button appear: the
                      select already shows the guessed category, and a <select>
                      fires no change event when you pick the option that is
                      already selected — so confirming needs its own control.
                    */}
                    <CategoryPicker
                      fingerprint={item.fingerprint}
                      currentId={item.categoryId}
                      currentName={item.categoryName}
                      isGuess
                    />
                  </span>
                )}
              </th>
              <td className="tnum py-2 text-right align-top">
                {item.cents === null ? '–' : formatBRL(item.cents)}
                {item.href && (
                  <Link
                    href={item.href}
                    className="ml-3 text-[12px] underline underline-offset-2"
                    style={{ color: 'var(--ink-faint)' }}
                  >
                    ver
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function ReviewPage() {
  const db = bootstrap(getDb());
  const queue = getReviewQueue(db);

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="font-serif text-4xl leading-none tracking-tight">Revisar</h1>
        <p className="text-[13px]" style={{ color: 'var(--ink-soft)' }}>
          chegaram desde <span className="tnum">{br(queue.since)}</span>
        </p>
      </div>

      {queue.total === 0 ? (
        <div className="mt-16 max-w-md">
          <h2 className="font-serif text-2xl">Nada novo desde {br(queue.since)}</h2>
          <p className="mt-2 text-[15px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            Nenhuma duplicata, nenhum valor fora do padrão e nenhuma categoria por decidir entre
            os lançamentos que chegaram depois dessa data.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-8 flex flex-wrap items-center gap-4">
            <ReviewActions total={queue.total} />
            <p className="max-w-xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              {queue.total} {queue.total === 1 ? 'item' : 'itens'}
              {queue.truncated && ` — mostrando os primeiros ${queue.items.length}`}. A data é a de
              chegada no app, não a da compra: na primeira vez, tudo é novo.
            </p>
          </div>

          <div className="space-y-10">
            {ORDER.map((kind) => (
              <Group key={kind} kind={kind} items={queue.items.filter((i) => i.kind === kind)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
