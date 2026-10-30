import state from '../utils/batteryState.js';

// A simulation for service sessions; this does not read server battery telemetry.
function installBatteryRuntime(model, batteryAtTime) {
  if (typeof navigator.getBattery !== 'function') return;
  const battery = new EventTarget();
  Object.defineProperty(battery, Symbol.toStringTag, { value: 'BatteryManager' });
  let observed = batteryAtTime(model);
  for (const key of ['level', 'charging', 'chargingTime', 'dischargingTime']) {
    Object.defineProperty(battery, key, { enumerable: true, get: () => batteryAtTime(model)[key] });
    Object.defineProperty(battery, `on${key.toLowerCase()}change`, { enumerable: true, writable: true, value: null });
  }
  const promise = Promise.resolve(battery);
  Object.defineProperty(navigator, 'getBattery', { configurable: true, value: () => promise });
  setInterval(() => {
    const next = batteryAtTime(model);
    for (const key of ['level', 'charging', 'chargingTime', 'dischargingTime']) {
      if (next[key] === observed[key]) continue;
      const type = `${key.toLowerCase()}change`, event = new Event(type);
      battery.dispatchEvent(event);
      if (typeof battery[`on${type}`] === 'function') battery[`on${type}`].call(battery, event);
    }
    observed = next;
  }, 30_000);
}

export function batteryRuntimeScript(model) {
  return `;(${installBatteryRuntime.toString()})(${JSON.stringify(model)}, ${state.batteryAtTime.toString()});`;
}
