import type { Metadata } from "next";
import "./globals.css";

import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import localFont from "next/font/local";

// The LeadRider pairing: Barlow Condensed (display) + Geist Sans (body).
// Vendored woff2s keep builds hermetic (no Google Fonts fetch), matching the
// landing page's approach. --font-body is bound to Geist in globals.css.
const displayFont = localFont({
  src: [
    { path: "./fonts/barlow-condensed-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/barlow-condensed-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/barlow-condensed-700.woff2", weight: "700", style: "normal" }
  ],
  variable: "--font-display",
  display: "swap"
});

export const metadata: Metadata = {
  title: "LeadRider",
  description: "LeadRider dealership operations platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${GeistSans.variable} ${GeistMono.variable} ${displayFont.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
