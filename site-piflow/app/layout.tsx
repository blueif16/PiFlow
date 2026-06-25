import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://piflow.sh"),
  title: "Pi Flow — workflows that design, run, and improve themselves",
  description:
    "A self-designing, durable, self-improving agent orchestration substrate. Describe the goal; an agent designs the graph, a fleet of sealed full-agent nodes runs it, and a learning loop makes it better every run.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${GeistMono.variable} antialiased`}
    >
      <body>{children}</body>
    </html>
  );
}
