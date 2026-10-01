import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  // Explicit, idempotent sample data. Re-running does not overwrite user edits.
  for (const [id, url, targetKeywords, status] of [
    ['sample-task-1', 'https://example.com/catalog', ['каталог', 'цена'], 'running'],
    ['sample-task-2', 'https://demo.playwright.dev/todomvc', ['todo'], 'paused'],
    ['sample-task-3', 'https://example.org/data', ['данные'], 'running'],
  ]) await prisma.task.upsert({ where: { id }, update: {}, create: { id, url, targetKeywords, status, project: { create: { name: `Демо ${id}`, targetUrl: url, yandexRegionId: "213", regionName: "" } }, profile: { create: { name: `Демо ${id}` } } } });
  for (const [id, host, port, username] of [
    ['sample-proxy-1', '192.0.2.14', 8000, 'sample_us'],
    ['sample-proxy-2', '198.51.100.28', 8080, 'sample_de'],
  ]) await prisma.proxy.upsert({ where: { host_port_username: { host, port, username } }, update: {}, create: { id, host, port, username, password: 'sample-not-real', isActive: false } });
  console.log('Sample data added. Sample proxies are disabled.');
} finally { await prisma.$disconnect(); }
