import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { DataProvider } from "@/lib/data-store";
import { AppShell } from "@/components/app-shell";
export const dynamic = "force-dynamic";
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login/");
  const defaultSidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  return <DataProvider><AppShell email={session.email} defaultSidebarOpen={defaultSidebarOpen}>{children}</AppShell></DataProvider>;
}
