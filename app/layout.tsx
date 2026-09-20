import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice-Activated Manual Assistant",
  description: "Ask questions aloud about your equipment manuals",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (e.g. Bitdefender) inject attrs like bis_skin_checked */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
