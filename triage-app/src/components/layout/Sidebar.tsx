"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CoinMark } from "@/components/ui/CoinMark";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/triage", label: "Triage" },
  { href: "/kids", label: "Kids" },
  { href: "/bills", label: "Bills" },
  { href: "/chat", label: "Ask" },
];

const bottomNavItems = [{ href: "/settings", label: "Settings" }];

export function Sidebar() {
  const pathname = usePathname();

  const linkClass = (isActive: boolean) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
      isActive
        ? "bg-gold/10 text-parchment font-medium border border-gold/25"
        : "text-muted hover:text-parchment hover:bg-card"
    }`;

  return (
    <aside className="w-56 border-r border-hair bg-elevated flex flex-col min-h-screen">
      <div className="px-4 py-5 border-b border-hair">
        <div className="flex items-center gap-2.5">
          <CoinMark size={30} />
          <div className="leading-none">
            <span className="font-serif font-bold text-xl tracking-wide">
              Tyrion<span className="text-gold">.</span>
            </span>
          </div>
        </div>
        <p className="eyebrow mt-2">Master of Coin</p>
      </div>

      <nav className="flex-1 px-3 py-4 flex flex-col">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href));
            return (
              <li key={item.href}>
                <Link href={item.href} className={linkClass(isActive)}>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <ul className="mt-auto space-y-1">
          {bottomNavItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link href={item.href} className={linkClass(isActive)}>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="px-4 py-4 border-t border-hair">
        <div className="flex items-center justify-between">
          <p className="text-xs text-dim">Last synced 12 min ago</p>
          <span className="src-tag monarch">Monarch</span>
        </div>
        <button className="mt-2.5 w-full px-3 py-1.5 rounded-md text-xs bg-card border border-border text-parchment hover:border-gold transition-colors">
          Sync now
        </button>
      </div>
    </aside>
  );
}
