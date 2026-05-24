import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LogIQ — Context-aware log investigation",
  description:
    "LogIQ turns large volumes of production logs and contextual artifacts into a single, evidence-backed investigation workspace.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased min-h-screen bg-background text-foreground">{children}</body>
    </html>
  );
}
