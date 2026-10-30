const { z } = require('zod');

const batteryModelSchema = z.object({
  version: z.literal(1), mode: z.literal('simulated'),
  cycleStartedAt: z.number().finite().nonnegative(),
  dischargeSeconds: z.number().finite().min(3600).max(86400),
  chargeSeconds: z.number().finite().min(1800).max(14400),
  minLevel: z.number().finite().min(0.05).max(0.3),
}).strict();

function createBatteryModel(profile) {
  if (profile.runtime?.battery) return batteryModelSchema.parse(profile.runtime.battery);
  const seed = profile.canvasSeed >>> 0;
  const dischargeSeconds = (6 + seed % 7) * 3600;
  const chargeSeconds = (1.5 + (seed >>> 4) % 4 * 0.5) * 3600;
  const minLevel = 0.15;
  const old = profile.fingerprint.battery;
  const level = Number.isFinite(old?.level) ? Math.max(minLevel, Math.min(1, old.level)) : (30 + (seed >>> 8) % 61) / 100;
  const phaseSeconds = old?.charging === true
    ? dischargeSeconds + (level - minLevel) / (1 - minLevel) * chargeSeconds
    : (1 - level) / (1 - minLevel) * dischargeSeconds;
  return batteryModelSchema.parse({ version: 1, mode: 'simulated', cycleStartedAt: Math.max(0, Date.parse(profile.createdAt) - phaseSeconds * 1000), dischargeSeconds, chargeSeconds, minLevel });
}

// Standalone pure function: also embedded in the browser's preload script.
function batteryAtTime(model, now = Date.now()) {
  const cycle = model.dischargeSeconds + model.chargeSeconds;
  const seconds = (now - model.cycleStartedAt) / 1000;
  const phase = ((seconds % cycle) + cycle) % cycle;
  const charging = phase >= model.dischargeSeconds;
  const rawLevel = charging
    ? model.minLevel + (phase - model.dischargeSeconds) / model.chargeSeconds * (1 - model.minLevel)
    : 1 - phase / model.dischargeSeconds * (1 - model.minLevel);
  return { level: Math.round(rawLevel * 100) / 100, charging,
    chargingTime: charging ? Math.ceil(cycle - phase) : Infinity,
    // Time until the simulated charger is connected, not until battery depletion.
    dischargingTime: Infinity };
}

module.exports = { batteryModelSchema, createBatteryModel, batteryAtTime };
