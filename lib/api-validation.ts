import { weightsSchema } from '@/utils/deviceCatalog';
import { validTimezone } from "@/utils/projectSchedule";
import { visitSettings as parseVisitSettings } from "@/utils/visitSettings";
import { z } from "zod";
import { DEFAULT_SEARCH_DEPTH, MIN_SEARCH_DEPTH, MAX_SEARCH_DEPTH } from "@/utils/searchTask";
import { normalizeDonorSites } from "@/utils/donorSites";

export const taskStatus = z.enum(["running", "paused", "completed", "failed"]);
export const taskType = z.enum(["warmup", "target"]);
const url = z.string().trim().max(2048).url().refine(value => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}, "Нужен HTTP(S) URL без авторизации");
const keywords = z.array(z.string().trim().min(1).max(200)).max(100);

const profileId = z.string().trim().uuid("Нужен UUID профиля").transform(value => value.toLowerCase());
const searchEngine = z.enum(["", "yandex", "mail", "dzen"]);
const searchDepth = z.number().int().min(MIN_SEARCH_DEPTH).max(MAX_SEARCH_DEPTH);
const phrases = z.array(z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]*$/, "Фраза должна быть одной строкой")).max(100).transform(items => [...new Set(items)]);
const targetExecutions = z.number().int().min(1).max(10000);
const taskConcurrency = z.number().int().min(1).max(10000);
const dailyExecutionLimit = z.number().int().min(1).max(10000).nullable();
const projectId = z.string().trim().min(1).max(128);
export function validTargetTask(data: { taskType?: string; projectId?: string | null; url?: string; searchEngine?: string; searchQueries?: unknown; vitalPhrases?: unknown }) {
  if (data.taskType === "warmup") return !data.projectId;
  if (!data.projectId) return false;
  if (data.searchEngine) return Array.isArray(data.searchQueries) && data.searchQueries.length > 0;
  return !(Array.isArray(data.searchQueries) && data.searchQueries.length) && !(Array.isArray(data.vitalPhrases) && data.vitalPhrases.length);
}
const visitSettingsSchema=z.record(z.string(),z.unknown()).refine(value=>{try{parseVisitSettings(value);return true;}catch{return false;}},"Проверьте настройки посещения: 15–1800 секунд, минимум не больше максимума, 0–10 переходов и до 30 путей разделов.").transform(value=>parseVisitSettings(value)||{});
const taskFields = {
  name: z.string().trim().min(1, "Укажите название задачи").max(100, "Название — до 100 символов").regex(/^[^\u0000-\u001f\u007f]*$/, "Название должно быть одной строкой").optional(),
  visitSettings:visitSettingsSchema.optional(),
  url: z.union([url, z.literal("")]).optional(), targetKeywords: keywords.optional(), status: taskStatus.optional(),
  projectId: projectId.nullable().optional(), targetExecutions: targetExecutions.optional(), concurrency: taskConcurrency.optional(),
  dailyExecutionLimit: dailyExecutionLimit.optional(),
  profileId: profileId.optional(), taskType: taskType.optional(),
  searchEngine: searchEngine.optional(), searchDepth: searchDepth.optional(), searchQueries: phrases.optional(), vitalPhrases: phrases.optional(),
};
export const createTaskSchema = z.object({
  ...taskFields, url: taskFields.url.default(""), targetKeywords: keywords.default([]), status: taskStatus.default("running"),
  targetExecutions: targetExecutions.default(1), concurrency: taskConcurrency.default(1), taskType: taskType.default("target"),
  dailyExecutionLimit: dailyExecutionLimit.default(null),
  searchEngine: searchEngine.default(""), searchDepth: searchDepth.default(DEFAULT_SEARCH_DEPTH), searchQueries: phrases.default([]), vitalPhrases: phrases.default([]),
}).strict().refine(validTargetTask, { path: ["projectId"], message: "Целевая задача должна принадлежать проекту; поисковому сценарию нужны фразы. Прогрев создаётся вне проекта." });
export const replaceTaskSchema = z.object(taskFields).strict();
export const updateTaskSchema = replaceTaskSchema.partial().refine(data => Object.keys(data).length > 0, "Нет полей для обновления");

export const createProfileSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  storageMode: z.enum(["snapshot", "persistent"]).optional(),
  status: z.enum(["banned"]).optional(),
  isEnabled: z.boolean().optional(),
}).strict().refine(data => Object.keys(data).length > 0, "Нет полей для обновления");

const host = z.string().trim().max(253).refine(value => {
  if (/^\d+(\.\d+){3}$/.test(value)) return value.split(".").every(part => Number(part) <= 255);
  return /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value)
    && value.split(".").every(part => part.length <= 63 && part && !part.startsWith("-") && !part.endsWith("-"));
}, "Некорректный IPv4-адрес или hostname");
const proxyFields = {
  host, port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(1000), isActive: z.boolean(),
  rotationUrl: url.nullable().optional(),
  channel: z.string().trim().max(100).optional(),
  purpose: z.enum(["shared", "warmup", "target"]).optional(),
};
export const createProxySchema = z.object({ ...proxyFields, isActive: z.boolean().default(true) }).strict();
export const replaceProxySchema = z.object(proxyFields).strict();
export const updateProxySchema = replaceProxySchema.partial().refine(data => Object.keys(data).length > 0, "Нет полей для обновления");
export const proxyPostSchema = z.union([
  createProxySchema,
  z.object({ proxies: z.array(createProxySchema).min(1).max(500) }).strict(),
]);

const secret = z.string().trim().min(1).max(500).regex(/^\S+$/, "Ключ не должен содержать пробелы").nullable();
export const settingsSchema = z.object({
  capguruApiKey: secret.optional(),
  captchaPrimary: z.enum(["rucaptcha", "capguru"]).optional(),
  captchaFallbackAfter: z.number().int().min(1).max(3).optional(),
  rucaptchaApiKey: secret.optional(),
  openaiApiKey: secret.optional(),
  mobileProxyApiKey: secret.optional(),
  fingerprintDeviceWeights: weightsSchema.optional(),
  fingerprintDevicePreset: z.enum(["mixed", "s23_android14"]).optional(),
  fingerprintMode: z.enum(["auto", "local", "mobileproxy"]).optional(),
  fingerprintLocale: z.string().max(35).refine(v => { try { return Intl.DateTimeFormat.supportedLocalesOf([v]).length > 0; } catch { return false; } }, "Неверная локаль").optional(),
  fingerprintTimezone: z.string().max(80).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "Неверный часовой пояс").optional(),
  expectedUpdatedAt: z.string().datetime().nullable().optional(),
  dailyProfileDemand: z.number().int().min(0).max(10000).optional(),
  readinessFreshnessHours: z.number().int().min(1).max(720).optional(),
  autoReplenishEnabled: z.boolean().optional(),
  warmupEnabled: z.boolean().optional(),
  warmupScheduleHours: z.string().regex(/^[01]{168}$/, "Расписание должно содержать 168 часовых ячеек").optional(),
  warmupScheduleTimezone: z.string().trim().max(100).refine(validTimezone, "Укажите корректный часовой пояс, например Europe/Moscow").optional(),
  warmupConcurrency: z.number().int().min(1).optional(),
  warmupSharedProxy: z.boolean().optional(),
  warmupPlanPreset: z.enum(['standard','storage','revisit','navigation']).optional(),
  warmupStageIntervalHours: z.number().finite().min(1 / 60).max(168).optional(),
  warmupSitePauses: z.array(z.object({ domain: z.string().regex(/^[a-z0-9.-]+$/i).max(253), until: z.string().datetime() }).strict()).optional(),
  warmupSites: z.array(z.string().trim().max(2048, "Адрес сайта должен содержать не больше 2048 символов")).min(3, "Укажите минимум 3 сайта для прогрева").superRefine((sites, context) => {
    if (sites.length < 3) return;
    try { normalizeDonorSites(sites); }
    catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Проверьте список сайтов" }); }
  }).transform(sites => normalizeDonorSites(sites)).optional(),
  maxPendingProfiles: z.number().int().min(100).max(10000).optional(),
  minReadyProfiles: z.number().int().min(1).max(10000).optional(),
  replenishBatchSize: z.number().int().min(1).max(1000).optional(),
}).strict().refine(data => Object.keys(data).length > 0, "Нет настроек для обновления");

export const projectGeolocationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({ mode: z.literal('region'), radiusKm: z.number().finite().min(0).max(50).optional() }).strict(),
  z.object({ mode: z.literal('manual'), latitude: z.number().finite().min(-85).max(85), longitude: z.number().finite().min(-180).max(180), radiusKm: z.number().finite().min(0).max(50) }).strict(),
]);
export const projectSchema = z.object({
  geolocation: projectGeolocationSchema.optional(),
  scheduleHours: z.string().regex(/^[01]{168}$/, "Расписание должно содержать 168 часовых ячеек").optional(),
  scheduleTimezone: z.string().trim().max(100).refine(validTimezone, "Укажите корректный часовой пояс, например Europe/Moscow").optional(),
  name: z.string().trim().min(1).max(100), targetUrl: url,
  yandexRegionId: z.string().trim().regex(/^[1-9]\d{0,9}$/, "Укажите положительный числовой ID региона").refine(value => Number(value) <= 2147483647, "ID региона слишком большой"),
  regionName: z.string().trim().max(100).optional(),
}).strict();
export const updateProjectSchema = projectSchema.partial().refine(data => Object.keys(data).length > 0, "Нет изменений");
export const profileBatchSchema = z.object({ count: z.number().int().min(1).max(1000), namePrefix: z.string().trim().min(1).max(60).default("Мобильный профиль"), warmup: z.literal(true).default(true) }).strict();
export const warmupBatchSchema = z.union([
  z.object({ count: z.number().int().min(1).max(1000) }).strict(),
  z.object({ profileIds: z.array(profileId).min(1).max(1000).refine(ids => new Set(ids).size === ids.length, "Повторяющиеся UUID") }).strict(),
]);
