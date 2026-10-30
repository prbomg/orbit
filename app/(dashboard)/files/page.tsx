import { ProjectFileManager } from "@/components/project-file-manager";

export default function FilesPage() {
  return <>
    <div className="page-heading"><div><div className="eyebrow">ОБСЛУЖИВАНИЕ ПРОЕКТА</div><h1>Файлы<span className="heading-dot">.</span></h1><p>Просмотр, скачивание и редактирование файлов Orbit.</p></div></div>
    <ProjectFileManager />
  </>;
}
