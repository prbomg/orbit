import { redirect } from "next/navigation";
import { Orbit, ShieldCheck } from "lucide-react";
import { getSession } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";
export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return <main className="login-page">
    <div className="login-glow" aria-hidden="true" />
    <section className="login-card" aria-labelledby="login-title">
      <div className="brand"><span className="brand-icon"><Orbit size={30} strokeWidth={1.7} /></span><span>orbit<span className="brand-period">.</span></span></div>
      <div className="brand-caption">BROWSER AUTOMATION</div>
      <div className="login-heading"><p className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</p><h1 id="login-title">Вход в Orbit<span className="heading-dot">.</span></h1><p>Ваши проекты, профили и задачи —<br />в одном пространстве.</p></div>
      <LoginForm />
      <div className="login-note"><ShieldCheck size={17} /><span>Доступ только для участников команды</span></div>
    </section>
    <footer className="login-footer">Orbit by ЮниВеб</footer>
  </main>;
}
