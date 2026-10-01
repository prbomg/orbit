import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataProvider } from "@/lib/data-store";
import "./globals.css";

export const metadata: Metadata = { title: "Orbit — браузерная автоматизация", description: "Панель управления задачами, прокси и настройками браузерной автоматизации." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" className="dark"><body><DataProvider><AppShell>{children}</AppShell></DataProvider></body></html>;
}
