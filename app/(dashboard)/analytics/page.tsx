"use client";
import { useEffect, useState } from "react";
import { Activity, ChartNoAxesCombined } from "lucide-react";
import { Button } from "@/components/ui/button";
import AnalyticsOverview from "@/components/analytics-overview";
import AnalyticsAttempts from "@/components/analytics-attempts";
import styles from "./analytics.module.css";

export default function AnalyticsPage() {
  const [tab, setTab] = useState("overview"), [ready, setReady] = useState(false);
  useEffect(() => {
    const read = () => { const q = new URLSearchParams(location.search); setTab(q.get("tab") === "attempts" || (!q.has("tab") && (q.has("projectId") || q.has("period"))) ? "attempts" : "overview"); setReady(true); };
    read(); window.addEventListener("popstate", read); return () => window.removeEventListener("popstate", read);
  }, []);
  function select(value: string) {
    const q = new URLSearchParams(location.search); q.set("tab", value);
    history.pushState(null, "", `/analytics/?${q}`); setTab(value);
  }
  return <div className={styles.page}>
    <div className="page-heading"><div><div className="eyebrow">СТАТИСТИКА ПРОЕКТОВ</div><h1>Диагностика<span className="heading-dot">.</span></h1><p>Текущая работа, результаты и подробности выполнений в одном месте.</p></div></div>
    <div className={styles.tabs} role="group" aria-label="Вид статистики">
      <Button variant={tab === "overview" ? "secondary" : "ghost"} aria-pressed={tab === "overview"} onClick={() => select("overview")}><ChartNoAxesCombined size={17}/>Обзор</Button>
      <Button variant={tab === "attempts" ? "secondary" : "ghost"} aria-pressed={tab === "attempts"} onClick={() => select("attempts")}><Activity size={17}/>Диагностика попыток</Button>
    </div>
    <p className={styles.scope}>{tab === "overview" ? "Все проекты: текущая нагрузка и ресурсы. График результатов учитывает время завершения попыток." : "Выбранные проект и период. Попытки учитываются по времени старта, поэтому показатели могут отличаться от графика обзора."}</p>
    {!ready ? <p role="status">Загрузка статистики…</p> : tab === "overview" ? <AnalyticsOverview/> : <AnalyticsAttempts/>}
  </div>;
}
