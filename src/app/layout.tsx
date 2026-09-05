import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'CRATE — a query engine for music discovery',
  description:
    'Natural-language music search that understands theory, not just popularity. Modal, scale-aware retrieval over an independent Creative Commons corpus.',
};

const NAV = [
  { href: '/', label: 'Search' },
  { href: '/analyze', label: 'Analyze' },
  { href: '/eval', label: 'Evaluation' },
  { href: '/corpus', label: 'Corpus' },
  { href: '/about', label: 'About' },
];

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <header className="border-b border-line sticky top-0 z-40 bg-bg/85 backdrop-blur-md">
          <div className="mx-auto max-w-6xl px-5 h-14 flex items-center gap-6">
            <Link href="/" className="flex items-baseline gap-2 shrink-0">
              <span className="font-mono text-[15px] font-semibold tracking-[0.2em] text-accent">CRATE</span>
              <span className="hidden sm:inline text-[11px] text-mute tracking-wide">query engine for music</span>
            </Link>
            <nav className="ml-auto flex items-center gap-1 text-[13px] overflow-x-auto">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-2.5 py-1.5 rounded-md text-dim hover:text-ink hover:bg-surface transition-colors whitespace-nowrap"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-line mt-16">
          <div className="mx-auto max-w-6xl px-5 py-7 text-[12px] text-mute flex flex-wrap gap-x-6 gap-y-2 justify-between">
            <span>
              Audio is Creative Commons licensed, streamed from the Internet Archive netlabels collection.
              Every track links to its source and licence.
            </span>
            <a
              className="hover:text-dim transition-colors"
              href="https://github.com/Froggo23/crate"
              target="_blank"
              rel="noreferrer noopener"
            >
              source on github
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
