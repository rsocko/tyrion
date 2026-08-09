import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tyrion | Money-domain configuration",
  description: "Independent household policy and unofficial Monarch connector operations",
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
