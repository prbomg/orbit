"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListTodo, Network, Settings2, Orbit, ChevronRight, Layers3, Activity, Fingerprint, FolderKanban, Files, LoaderCircle } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useData } from "@/lib/data-store";
import { LogoutButton } from "@/components/logout-button";

const navigation = [
  { url: "/", title: "Проекты", icon: FolderKanban },
  { url: "/tasks", title: "Задачи", icon: ListTodo },
  { url: "/analytics", title: "Диагностика", icon: Activity },
  { url: "/profiles", title: "Профили", icon: Fingerprint },
  { url: "/proxies", title: "Прокси", icon: Network },
  { url: "/files", title: "Файлы", icon: Files },
  { url: "/settings", title: "Настройки", icon: Settings2 },
];

function Navigation({ email }: { email: string }) {
  const pathname = usePathname();
  const { tasks } = useData();
  const { setOpenMobile, isMobile, state } = useSidebar();
  return <Sidebar collapsible="icon" className="orbit-sidebar border-r border-border">
    <SidebarHeader className="px-6 py-7">
      <Link href="/" className="brand" aria-label="Orbit — главная"><span className="brand-icon"><Orbit size={25} strokeWidth={1.7} /></span><span className="brand-name">orbit<span className="brand-period">.</span></span></Link>
      <span className="brand-caption">УПРАВЛЕНИЕ ПРОЕКТАМИ</span>
    </SidebarHeader>
    <SidebarContent id="orbit-navigation" className="px-3 pt-6">
      <SidebarGroup>
        <SidebarGroupLabel className="mb-3 px-3 text-xs tracking-[.12em]">НАВИГАЦИЯ</SidebarGroupLabel>
        <SidebarMenu className="gap-2">
          {navigation.map(item => <SidebarMenuItem key={item.url}>
            <SidebarMenuButton asChild tooltip={item.title} isActive={pathname === item.url || (item.url === "/" && pathname.startsWith("/projects")) || (item.url !== "/" && pathname.startsWith(`${item.url}/`))} className="h-11 rounded-lg px-3 text-sm data-[active=true]:bg-primary/10 data-[active=true]:text-primary">
              <Link href={item.url} aria-label={item.title} onClick={() => setOpenMobile(false)}><item.icon size={18} /><span>{item.title}</span>{item.url === "/tasks" && <span className="nav-count">{tasks.filter(t => t.status === "running").length}</span>}</Link>
            </SidebarMenuButton>
          </SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="px-5 pb-5">
      <div className="workspace-profile"><span className="avatar" title={`Uniofweb · ${email}`}>UW</span><div className="workspace-details min-w-0"><strong>Uniofweb</strong><span className="truncate" title={email}>{email}</span></div></div>
      <LogoutButton compact={!isMobile && state === "collapsed"} />
    </SidebarFooter>
  </Sidebar>;
}

function MenuToggle() {
  const { isMobile, open, openMobile } = useSidebar();
  const label = isMobile ? "Открыть меню" : open ? "Свернуть меню" : "Развернуть меню";
  return <SidebarTrigger className="mr-2 shrink-0" aria-label={label} title={label} aria-expanded={isMobile ? openMobile : open} aria-controls="orbit-navigation" />;
}

export function AppShell({ children, email, defaultSidebarOpen = true }: { children: React.ReactNode; email: string; defaultSidebarOpen?: boolean }) {
  const pathname = usePathname();
  const { error, loading, refresh } = useData();
  const current = navigation.find(n => pathname === n.url || (n.url === "/" && pathname.startsWith("/projects")) || (n.url !== "/" && pathname.startsWith(`${n.url}/`))) ?? navigation[0];
  return <SidebarProvider defaultOpen={defaultSidebarOpen} style={{ "--sidebar-width": "15.5rem", "--sidebar-width-icon": "4.5rem" } as React.CSSProperties}>
    <Navigation email={email} />
    <SidebarInset className="min-w-0">
      <header className="topbar"><div className="breadcrumb"><MenuToggle /><Layers3 size={16} /><span>Рабочее пространство</span><ChevronRight size={14} /><strong>{current.title}</strong></div><div role="status" className="shell-load-status">{loading && <><LoaderCircle size={14} className="animate-spin" aria-hidden="true"/><span className="shell-load-label">Загрузка данных…</span></>}</div></header>
      <div className="page-content">{error && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4"><p className="form-error">{error}</p><button className="text-sm text-primary" onClick={() => void refresh()} disabled={loading}>Повторить загрузку</button></div>}{children}</div>
      <footer className="page-footer"><span>Orbit by ЮниВеб</span></footer>
    </SidebarInset>
  </SidebarProvider>;
}
