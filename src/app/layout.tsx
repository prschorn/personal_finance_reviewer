import type { Metadata } from 'next';
import { Instrument_Sans, Newsreader } from 'next/font/google';
import { Nav } from './_components/Nav';
import './globals.css';

// Two families with clearly separate jobs: the serif names things, the sans
// counts things. Figures never appear in the serif, labels never in the sans.
const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument-sans', display: 'swap' });
const serif = Newsreader({ subsets: ['latin'], variable: '--font-newsreader', display: 'swap', style: ['normal', 'italic'] });

export const metadata: Metadata = {
  title: 'Finanças',
  description: 'Gastos mensais por categoria',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${sans.variable} ${serif.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <Nav />
        <main className="px-5 pb-20 pt-6 sm:px-8">{children}</main>
      </body>
    </html>
  );
}
