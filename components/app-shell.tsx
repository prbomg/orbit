"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ListTodo, Network, Settings2, Orbit, ChevronRight, Layers3, FlaskConical, Fingerprint, RefreshCw, FolderKanban } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useData } from "@/lib/data-store";

const navigation = [
  { url: "/", title: "Главная", icon: LayoutDashboard, english: "Dashboard" },
  { url: "/projects", title: "Проекты", icon: FolderKanban, english: "Projects" },
  { url: "/tasks", title: "Задачи", icon: ListTodo, english: "Tasks" },
  { url: "/profiles", title: "Профили", icon: Fingerprint, english: "Profiles" },
  { url: "/proxies", title: "Прокси", icon: Network, english: "Proxies" },
  { url: "/settings", title: "Настройки", icon: Settings2, english: "Settings" },
];

function Navigation() {
  const pathname = usePathname();
  const { tasks } = useData();
  const { setOpenMobile } = useSidebar();
  return <Sidebar className="border-r border-border">
    <SidebarHeader className="px-6 py-7">
      <Link href="/" className="brand" aria-label="Orbit — главная"><span className="brand-icon"><Orbit size={25} strokeWidth={1.7} /></span><span>orbit<span className="brand-period">.</span></span></Link>
      <span className="brand-caption">BROWSER AUTOMATION</span>
    </SidebarHeader>
    <SidebarContent className="px-3 pt-6">
      <SidebarGroup>
        <SidebarGroupLabel className="mb-3 px-3 text-xs tracking-[.12em]">РАБОЧЕЕ ПРОСТРАНСТВО</SidebarGroupLabel>
        <SidebarMenu className="gap-2">
          {navigation.map(item => <SidebarMenuItem key={item.url}>
            <SidebarMenuButton asChild isActive={pathname === item.url || (item.url !== "/" && pathname.startsWith(`${item.url}/`))} className="h-11 rounded-lg px-3 text-sm data-[active=true]:bg-primary/10 data-[active=true]:text-primary">
              <Link href={item.url} onClick={() => setOpenMobile(false)}><item.icon size={18} /><span>{item.title}</span>{item.url === "/tasks" && <span className="nav-count">{tasks.filter(t => t.status === "running").length}</span>}</Link>
            </SidebarMenuButton>
          </SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="px-5 pb-5">
      <div className="demo-note"><FlaskConical size={16} /><div><strong>Рабочее пространство</strong><p>Задачи и прокси<br />сохраняются в базе.</p></div></div>
      <div className="workspace-profile"><span className="avatar">SR</span><div><strong>Моё пространство</strong><span>Личный аккаунт</span></div></div>
    </SidebarFooter>
  </Sidebar>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { error, loading, refresh, lastUpdated } = useData();
  const current = navigation.find(n => pathname === n.url || (n.url !== "/" && pathname.startsWith(`${n.url}/`))) ?? navigation[0];
  return <SidebarProvider style={{ "--sidebar-width": "15.5rem" } as React.CSSProperties}>
    <Navigation />
    <SidebarInset className="min-w-0">
      <header className="topbar"><div className="breadcrumb"><SidebarTrigger className="mr-2 md:hidden" aria-label="Открыть меню" /><Layers3 size={16} /><span>Рабочее пространство</span><ChevronRight size={14} /><strong>{current.english}</strong></div><div className="flex items-center gap-2"><button onClick={() => void refresh()} disabled={loading} aria-label="Обновить данные" className="rounded-md p-2 text-muted-foreground hover:text-primary"><RefreshCw size={15} /></button><div className="demo-badge"><Network size={14} />{loading ? "Загрузка…" : error ? "Ошибка загрузки" : lastUpdated ? `Обновлено ${new Date(lastUpdated).toLocaleTimeString("ru-RU")}` : "Ожидание данных"}</div></div></header>
      <div className="page-content">{loading && <p role="status" className="mb-5 text-sm text-muted-foreground">Загрузка данных…</p>}{error && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4"><p className="form-error">{error}</p><button className="text-sm text-primary" onClick={() => void refresh()} disabled={loading}>Повторить загрузку</button></div>}{children}</div>
      <footer className="page-footer"><span>Orbit Console</span><span>Задачи и прокси сохраняются в SQLite</span><span className="mono">v.1.0</span></footer>
    </SidebarInset>
  </SidebarProvider>;
}
