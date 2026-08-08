import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tyrion | Monarch connector operations",
  description: "Operational setup and maintenance for Tyrion's Monarch connector",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
