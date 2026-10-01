import { z } from "zod";

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
const phrases = z.array(z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]*$/, "Фраза должна быть одной строкой")).max(100).transform(items => [...new Set(items)]);
const targetExecutions = z.number().int().min(1).max(10000);
const projectId = z.string().trim().min(1).max(128);
export function validTargetTask(data: { taskType?: string; projectId?: string | null; url?: string; searchEngine?: string; searchQueries?: unknown; vitalPhrases?: unknown }) {
  if (data.taskType === "warmup") return !data.projectId;
  if (!data.projectId) return false;
  if (data.searchEngine) return Array.isArray(data.searchQueries) && data.searchQueries.length > 0;
  return !(Array.isArray(data.searchQueries) && data.searchQueries.length) && !(Array.isArray(data.vitalPhrases) && data.vitalPhrases.length);
}
const taskFields = {
  url: z.union([url, z.literal("")]).optional(), targetKeywords: keywords.optional(), status: taskStatus.optional(),
  projectId: projectId.nullable().optional(), targetExecutions: targetExecutions.optional(),
  profileId: profileId.optional(), taskType: taskType.optional(),
  searchEngine: searchEngine.optional(), searchQueries: phrases.optional(), vitalPhrases: phrases.optional(),
};
export const createTaskSchema = z.object({
  ...taskFields, url: taskFields.url.default(""), targetKeywords: keywords.default([]), status: taskStatus.default("running"),
  targetExecutions: targetExecutions.default(1), taskType: taskType.default("target"),
  searchEngine: searchEngine.default(""), searchQueries: phrases.default([]), vitalPhrases: phrases.default([]),
}).strict().refine(validTargetTask, { path: ["projectId"], message: "Целевая задача должна принадлежать проекту; поисковому сценарию нужны фразы. Прогрев создаётся вне проекта." });
export const replaceTaskSchema = z.object(taskFields).strict();
export const updateTaskSchema = replaceTaskSchema.partial().refine(data => Object.keys(data).length > 0, "Нет полей для обновления");

export const createProfileSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["new", "warming_up", "ready", "banned"]).optional(),
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
  rucaptchaApiKey: secret.optional(),
  openaiApiKey: secret.optional(),
  autoReplenishEnabled: z.boolean().optional(),
  minReadyProfiles: z.number().int().min(1).max(10000).optional(),
  replenishBatchSize: z.number().int().min(1).max(1000).optional(),
}).strict().refine(data => Object.keys(data).length > 0, "Нет настроек для обновления");

export const projectSchema = z.object({
  name: z.string().trim().min(1).max(100), targetUrl: url,
  yandexRegionId: z.string().trim().regex(/^[1-9]\d{0,9}$/, "Укажите положительный числовой ID региона").refine(value => Number(value) <= 2147483647, "ID региона слишком большой"),
  regionName: z.string().trim().max(100).optional(),
}).strict();
export const updateProjectSchema = projectSchema.partial().refine(data => Object.keys(data).length > 0, "Нет изменений");
export const profileBatchSchema = z.object({ count: z.number().int().min(1).max(1000), namePrefix: z.string().trim().min(1).max(60).default("Мобильный профиль"), warmup: z.boolean().default(true) }).strict();
export const warmupBatchSchema = z.union([
  z.object({ count: z.number().int().min(1).max(1000) }).strict(),
  z.object({ profileIds: z.array(profileId).min(1).max(1000).refine(ids => new Set(ids).size === ids.length, "Повторяющиеся UUID") }).strict(),
]);
