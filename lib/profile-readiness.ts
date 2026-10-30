import cookieAge from "@/utils/cookieAge";
import readiness from "@/utils/profileReadiness";
export type SessionMetadata = {
  backupAvailable?: boolean; snapshotId?: string|null; passportHash?: string|null;
  state: string; savedAt: string | null; cookiesCount: number; activeCookiesCount: number; expiredCookiesCount: number;
  sessionCookiesCount: number; originsCount: number; localStorageEntriesCount: number; indexedDBDatabasesCount: number;
  indexedDBStoresCount: number; indexedDBRecordsCount: number; hasData: boolean; sizeBytes: number;
};
export type Readiness = { state: string; label: string; reason: string; checks: { label: string; state: "passed" | "failed" | "pending"; detail: string }[] };
export const sessionErrorMessage = (code: string) => ({
  ENOSPC: "На сервере не хватило места на диске. Сохранённые этапы профиля можно продолжить после освобождения места.",
  EDQUOT: "Достигнута дисковая квота. Нужны свободное место или увеличение квоты.",
  profile_disk_full: "Недостаточно места на диске. Прогрев ожидает освобождения места; лимит ошибок профиля не расходуется.",
  profile_publication_recovery_required: "Сохранение прервано. Требуется восстановление согласованной версии сессии.",
  profile_publication_conflict: "Версия в базе не соответствует журналу сохранения. Требуется проверка.",
  profile_publication_busy: "Сессию восстанавливает другой исполнитель.",
  previous_snapshot: "Восстановлена предыдущая сессия. Перед использованием нужна проверка.",
  site_rate_limited: "Сайт ограничил частоту запросов (HTTP 429). Посещения отложены.",
  site_cooldown_or_busy: "Сайт временно на паузе или уже посещается на этом канале.",
  passport_invalid: "Параметры паспорта противоречат друг другу. Проверьте паспорт устройства.",
  profile_snapshot_mismatch: "Версия или контрольная сумма снимка не совпадает. Нужна проверка либо восстановление предыдущей сессии.",
  profile_storage_version_mismatch: "Версии JSON и постоянного хранилища не совпадают. Нужна проверка либо восстановление предыдущей сессии.",
  database_busy: "База данных временно занята. Текущий этап повторится автоматически; лимит ошибок профиля не расходуется.",
  worker_interrupted: "Служба прогрева прервалась. Текущий этап повторится автоматически; лимит ошибок профиля не расходуется.",
  browser_qualification_failed: "Контрольная группа не прошла проверку Chromium. Допуск остановлен до устранения расхождений.",
  tcp_unverified: "TCP-пресет канала не подтверждён. Проверьте его в разделе «Прокси».",
  tcp_profile_changed: "TCP-пресет у провайдера отличается от настроек канала.",
  tcp_os_mismatch: "ОС профиля не подходит TCP-пресету канала.",
  tcp_provider_unavailable: "TCP API MobileProxy временно недоступен.",
  motion_cdp_unsupported: "Браузер не поддерживает эмуляцию датчиков. Прогрев продолжается с обычным поведением браузера.",
  motion_backend_unavailable: "Эмуляция датчиков недоступна. Прогрев продолжается с обычным поведением браузера.",
  profile_browser_storage_limit: "Хранилище браузера превысило лимит 100 МБ. Нужна проверка профиля.",
  profile_minimum_age: "Минимальный срок подготовки ещё не прошёл.",
  profile_readiness_incomplete: "Не все проверки готовности пройдены.",
  profile_session_missing: "Нет сохранённой сессии. Запустите прогрев.",
  profile_not_warmed: "Сохранённая сессия недоступна. Запустите прогрев.",
  profile_session_empty: "В сессии нет действующих cookies и сохранённых данных сайтов. Нужен повторный обход.",
  profile_session_verification_failed: "Сохранённые данные не восстановились полностью. Нужна повторная проверка сессии.",
  invalid_or_unreadable_profile: "Файл сессии повреждён или недоступен.",
  profile_state_invalid: "Не удалось сохранить состояние браузера.",
  profile_too_large: "Размер сессии превысил допустимые 10 МБ.",
  fingerprint_verification_failed: "Параметры браузера не прошли проверку отпечатка.",
  proxy_check_failed: "Прокси не прошёл проверку подключения.",
  network: "Ошибка сети при подключении или смене IP прокси.",
  navigation_timeout: "Сайт не ответил вовремя.",
  warmup_sites_unavailable: "Сайты для прогрева временно недоступны. Назначен автоматический повтор; завершённые этапы сохранены.",
  warmup_operation_timeout: "Операция прогрева превысила отведённое время. Последний сохранённый этап не изменён.",
  warmup_site_timeout: "Превышен предел времени посещения сайта.",
  warmup_session_timeout: "Исчерпан бюджет времени сессии прогрева.",
  warmup_run_timeout: "Превышен общий предел времени запуска прогрева.",
  warmup_cleanup_timeout: "Завершение операции заняло больше отведённого времени.",
  proxy_rotation_rejected: "Провайдер отклонил запрос смены IP прокси.",
  proxy_rotation_invalid_response: "Провайдер вернул некорректный ответ при смене IP.",
  proxy_shared_preparation_failed: "Общий прокси не завершил подготовку. Прогрев повторится после восстановления канала.",
}[code] ?? "Прогрев остановлен из-за ошибки. Повторите попытку; код доступен в подсказке.");

type ProfileDiagnostic = { status: string; isEnabled: boolean; warmedAt: Date | string | null; fingerprintState: string;
  snapshotId?:string|null; readinessVersion?: number;
  readinessVerifiedAt?: Date | string | null; readinessValidUntil?: Date | string | null; deletedAt?: Date | string | null; sessionCheck: unknown; warmupJob: { status: string; minReadyAt?: Date | string | null; stage?: string; errorCode: string | null } | null };
export function profileReadiness(profile: ProfileDiagnostic, session: SessionMetadata): Readiness {
  const check = profile.sessionCheck as { status?: string; checkedAt?: string; errorCode?: string; sourceSavedAt?: string; cookieObservations?:Parameters<typeof cookieAge.assessCookieAge>[0]; processRestartVerified?:boolean; sourceSnapshotId?:string|null; missingCookies?: number; missingLocalStorageEntries?: number; mismatchedIndexedDBItems?: number } | null;
  const age=cookieAge.assessCookieAge(check?.cookieObservations);
  const warmupDone = Boolean(profile.warmedAt);
  const saved = session.state === "saved" && session.hasData && Boolean(profile.snapshotId) && session.snapshotId === profile.snapshotId;
  const restored = readiness.verifiedSnapshot(check, session.snapshotId, session.savedAt, session.passportHash);
  const checks: Readiness["checks"] = [
    { label: "Все этапы прогрева", state: warmupDone ? "passed" : "pending", detail: warmupDone ? "Прогрев завершён" : "Ожидается завершение прогрева" },
    { label: "Минимальный срок подготовки", state: profile.warmupJob?.minReadyAt && new Date(profile.warmupJob.minReadyAt).getTime() <= Date.now() || warmupDone && Boolean(profile.readinessVerifiedAt) ? 'passed' : 'pending', detail: profile.warmupJob?.minReadyAt ? `Возраст профиля достаточен с ${new Date(profile.warmupJob.minReadyAt).toLocaleString('ru-RU')}; также должны завершиться все сессии` : 'Отсчитывается от первой успешной сессии' },
    { label: "Сохранённая сессия", state: saved ? "passed" : warmupDone || profile.status === "new" || profile.status === "queued" || profile.status === "warming_up" ? "pending" : "failed", detail: session.state === 'pending_commit' ? 'Восстанавливается прерванное сохранение' : session.state === "missing" ? "Файл ещё не создан" : session.state === "unreadable" ? "Файл повреждён или недоступен" : session.state === "unsaved" ? "Браузер ещё не сохранил сессию" : !profile.snapshotId ? 'Нужна повторная аттестация сохранённой сессии' : session.snapshotId !== profile.snapshotId ? 'Версия файла не совпадает с базой' : session.hasData ? "Есть действующие cookies или данные сайтов" : "Нет действующих cookies и данных сайтов" },
    { label: "Восстановление сессии", state: restored ? "passed" : check?.status === "failed" ? "failed" : "pending", detail: restored ? "Этот снимок проверен после полного перезапуска браузера" : check?.errorCode ? sessionErrorMessage(check.errorCode) : "Нужна проверка этого снимка по текущему стандарту после полного перезапуска браузера" },
    { label: "Отпечаток браузера", state: profile.fingerprintState === "verified" ? "passed" : profile.fingerprintState === "failed" ? "failed" : "pending", detail: profile.fingerprintState === "verified" ? "Проверка отпечатка пройдена" : "Ожидается успешная проверка отпечатка" },
    { label: "Актуальность допуска", state: profile.readinessVersion === readiness.VERIFICATION_VERSION && profile.readinessVerifiedAt && profile.readinessValidUntil && new Date(profile.readinessValidUntil).getTime() > Date.now() ? 'passed' : 'pending', detail: profile.readinessVersion !== readiness.VERIFICATION_VERSION ? 'Нужна аттестация по текущему стандарту' : profile.readinessValidUntil ? `Проверка действительна до ${new Date(profile.readinessValidUntil).toLocaleString('ru-RU')}` : 'Допуск будет выдан после финальной проверки' },
  ];
  if(age.status!=='disabled')checks.push({label:'Возраст cookies',state:age.status==='passed'?'passed':'pending',detail:age.status==='missing'?`Не наблюдались cookies: ${age.missing.join(', ')}`:`Минимум ${age.minimumHours} ч. от первого наблюдения; ${age.readyAt?`допуск с ${new Date(age.readyAt).toLocaleString('ru-RU')}`:'ожидается наблюдение'}`});
  if (!profile.isEnabled || profile.status === "banned") return { state: "disabled", label: "Недоступен для задач", reason: profile.status === "banned" ? "Профиль заблокирован" : "Профиль выключен", checks };
  if(profile.warmupJob?.stage==='cookie_age_wait')return {state:'waiting',label:'Ожидает возраста cookies',reason:age.status==='missing'?`Не наблюдались cookies: ${age.missing.join(', ')}`:age.readyAt?`Проверка возможна с ${new Date(age.readyAt).toLocaleString('ru-RU')}`:'Ожидается наблюдение cookies',checks};
  if (profile.warmupJob?.status === "paused") return { state: "paused", label: "Прогрев на паузе", reason: profile.warmupJob.errorCode ? `Прогрев приостановлен. Последняя ошибка: ${sessionErrorMessage(profile.warmupJob.errorCode)}` : "Прогрев приостановлен", checks };
  if (profile.warmupJob?.errorCode && profile.warmupJob.status === "retry_wait") return { state: "waiting", label: profile.warmupJob.stage?.endsWith('_disk_wait') ? "Ожидает свободного места" : profile.warmupJob.stage?.endsWith('_proxy_wait') ? "Ожидает восстановления прокси" : profile.warmupJob.stage?.endsWith('_sites_wait') ? "Ожидает доступных сайтов" : "Ожидает повтора", reason: sessionErrorMessage(profile.warmupJob.errorCode), checks };
  if (profile.warmupJob?.errorCode) return { state: "attention", label: "Требует внимания", reason: sessionErrorMessage(profile.warmupJob.errorCode), checks };
  if (readiness.confirmed(profile) && checks.every(item => item.state === "passed")) return { state: "ready", label: "Готовность подтверждена", reason: "Прогрев, сессия, восстановление и отпечаток проверены", checks };
  if (warmupDone) return { state: "needs_check", label: "Нужна проверка", reason: checks.find(item => item.state !== 'passed')?.detail || 'Нужна повторная аттестация', checks };
  return { state: "warming", label: "Ещё не готов", reason: check?.status === "failed" ? checks[3].detail : "Ожидается прохождение всех этапов прогрева", checks };
}
