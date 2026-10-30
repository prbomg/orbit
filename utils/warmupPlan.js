const HOUR = 3600000;
const labels = ['Первое знакомство', 'Возвращение на сайты', 'Сессия после перерыва', 'Продолжение истории', 'Проверка устойчивости', 'Финальная проверка'];
const presets = {
  standard: { label: 'Стандартная подготовка', offsets: [0, 2 / 3, 2, 3, 4, 6], sessionMinutes: 3, sitesPerSession: 3, requirements: 'interaction' },
  storage: { label: 'Сохранение состояния', offsets: [0], sessionMinutes: 1, sitesPerSession: 1, requirements: 'content' },
  revisit: { label: 'Повторное посещение', offsets: [0, 1], sessionMinutes: 2, sitesPerSession: 1, requirements: 'return' },
  navigation: { label: 'Мобильная навигация', offsets: [0, 1], sessionMinutes: 2, sitesPerSession: 2, requirements: 'navigation' },
};
function createPlan(settings = {}, mode = 'preparation') {
  if (mode === 'verification') return { version: 2, mode, label: 'Проверка готовности', offsetsHours: [0], minAgeHours: 0, sessionMinutes: 0, sitesPerSession: 0, requirements: 'restore' };
  const preset = settings.warmupPlanPreset ?? 'standard';
  const config = presets[preset];
  if (!config) throw new Error('invalid_warmup_plan');
  const interval = (settings.warmupStageIntervalMinutes ?? 720) / 60;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('invalid_warmup_interval');
  const offsetsHours = config.offsets.map(v => Math.round(v * interval * 60) / 60);
  const minAgeHours = offsetsHours.at(-1);
  return { version: 2, mode, preset, label: `${config.label} · ${Math.round(minAgeHours)} ч. · ${offsetsHours.length} сессий`, offsetsHours, minAgeHours, sessionMinutes: config.sessionMinutes, sitesPerSession: config.sitesPerSession, requirements: config.requirements };
}
function validPlan(plan) {
  return Boolean(plan && [1, 2].includes(plan.version) && ['preparation', 'verification'].includes(plan.mode) && Array.isArray(plan.offsetsHours) && plan.offsetsHours.length > 0 && plan.offsetsHours.every((v, i, all) => Number.isFinite(v) && v >= 0 && (!i || v > all[i - 1])) && Number.isFinite(plan.minAgeHours) && plan.minAgeHours >= 0 &&
    (plan.version === 1 || (Number.isFinite(plan.sessionMinutes) && plan.sessionMinutes >= 0 && plan.sessionMinutes <= 10 && Number.isInteger(plan.sitesPerSession) && plan.sitesPerSession >= (plan.mode === 'verification' ? 0 : 1) && plan.sitesPerSession <= 12 && ['content','interaction','return','navigation','restore'].includes(plan.requirements))));
}
function planFor(job, settings) { return validPlan(job.plan) ? job.plan : createPlan(settings); }
function executionOptions(plan, stage = 1) {
  return { requiredSites: plan.sitesPerSession ?? 3, requirements: plan.version === 2 ? plan.requirements === 'return' ? stage > 1 ? 'return' : 'content' : plan.requirements : 'interaction' };
}
function nextRunAt(plan, stage, firstSessionAt, completedAt) {
  const nominal = new Date(firstSessionAt).getTime() + plan.offsetsHours[stage - 1] * HOUR;
  const spacing = (plan.offsetsHours[stage - 1] - plan.offsetsHours[stage - 2]) * HOUR;
  return new Date(Math.max(nominal, new Date(completedAt).getTime() + spacing));
}
function stageLabel(job) { return job.plan?.mode === 'verification' ? 'Проверка готовности' : job.plan?.preset && job.plan.preset !== 'standard' ? presets[job.plan.preset]?.label || 'Сессия подготовки' : labels[job.currentStage - 1] || 'Сессия прогрева'; }
module.exports = { HOUR, labels, presets, createPlan, validPlan, executionOptions, planFor, nextRunAt, stageLabel };
