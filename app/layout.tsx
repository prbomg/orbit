import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Orbit — браузерная автоматизация", description: "Панель управления задачами, прокси и настройками браузерной автоматизации." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" className="dark"><body>{children}</body></html>;
}
