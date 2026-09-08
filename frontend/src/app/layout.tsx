import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Zoom Workplace Clone",
  description: "A modern video conferencing dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The bare root: the app shell (sidebar + header) lives in the (app) route
  // group so meeting rooms render full-bleed without it.
  return (
    <html lang="en">
      <body className={`${inter.className} bg-[#eef1f5] text-slate-950 antialiased`}>
        {children}
      </body>
    </html>
  );
}
