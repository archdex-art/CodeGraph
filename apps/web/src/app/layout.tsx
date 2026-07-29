import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { GitBranch } from "lucide-react";
import { AuthNav } from "@/components/AuthNav";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CodeGraph — App",
  description: "Index a repository, build its knowledge graph, and get a Health Score.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#050505] text-gray-200">
        <header className="border-b border-white/5 bg-[#050505]/80 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2 font-semibold text-white">
              <GitBranch className="w-5 h-5 text-purple-400" />
              CodeGraph
              <span className="text-xs font-normal text-gray-500 border border-white/10 rounded px-1.5 py-0.5 ml-1">app</span>
            </Link>
            <nav className="flex items-center gap-6 text-sm text-gray-400">
              <Link href="/" className="hover:text-white transition-colors">Index</Link>
              <Link href="/dashboard" className="hover:text-white transition-colors">Dashboard</Link>
              <Link href="/settings" className="hover:text-white transition-colors">Settings</Link>
              <AuthNav />
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-white/5 py-6 text-center text-xs text-gray-600">
          CodeGraph · the world model of your software
        </footer>
      </body>
    </html>
  );
}
