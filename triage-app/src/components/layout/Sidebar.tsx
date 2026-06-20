"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/triage", label: "Triage", icon: "📋" },
  { href: "/kids", label: "Kids", icon: "👦" },
  { href: "/bills", label: "Bills", icon: "📅" },
  { href: "/chat", label: "Chat", icon: "💬" },
];

const bottomNavItems = [
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 border-r border-border bg-[#0d0d0d] flex flex-col min-h-screen">
      <div className="px-4 py-5 border-b border-border">
        <h1 className="text-lg font-bold">💰 Finance</h1>
        <p className="text-xs text-muted mt-0.5">Personal Finance Manager</p>
      </div>

      <nav className="flex-1 px-3 py-4 flex flex-col">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href));
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-accent/10 text-white font-medium border border-accent/20"
                      : "text-muted hover:text-white hover:bg-card"
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
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
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-accent/10 text-white font-medium border border-accent/20"
                      : "text-muted hover:text-white hover:bg-card"
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="px-4 py-4 border-t border-border">
        <p className="text-xs text-muted">Last synced: 12 min ago</p>
        <button className="mt-2 w-full px-3 py-1.5 rounded-md text-xs bg-card border border-border hover:bg-zinc-800 transition-colors">
          Sync Now
        </button>
      </div>
    </aside>
  );
}
