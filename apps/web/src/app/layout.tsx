import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * Instrument Serif carries every headline, and its italic is the emphasis
 * device throughout. A serif against mono data is the whole typographic idea:
 * the prose is editorial, the numbers are instrumentation, and the contrast
 * between them is what stops this reading like every other developer tool.
 *
 * Single weight by design — the family has one, and reaching for a bold that
 * does not exist is what produces synthesised, smeared headlines.
 */
const instrument = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "CodeGraph — see the codebase, then judge it, then fix it",
  description:
    "A symbol-level graph of your repository, an explainable Health Score, and fixes proved against your own test suite. One container, one SQLite file, no API key.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrument.variable} h-full antialiased`}
    >
      <body className="grain relative flex min-h-full flex-col bg-[var(--ink-900)] text-[var(--text-primary)]">
        <SiteHeader />
        <main className="relative z-[2] flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
