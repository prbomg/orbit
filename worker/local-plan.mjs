import { randomInt } from './behavior.mjs';
import { parseActionPlan } from './ai-plan.mjs';

/** A bounded browser QA sequence generated locally, without an API request. */
export function generateLocalActionPlan(maxDurationMs, log = () => {}, taskId) {
  const count = randomInt(10, 15);
  const shortRun = maxDurationMs < 20_000;
  const scroll = type => ({ type, pixels: randomInt(150, 850) });
  const move = () => ({ type: 'move_mouse_randomly', durationMs: randomInt(100, shortRun ? 180 : 800) });
  const actions = [scroll('scroll_down'), move(), scroll('scroll_up')];
  for (let index = actions.length; index < count; index++) {
    const choice = randomInt(1, 100);
    if (!shortRun && choice <= 12) actions.push({ type: 'pause', durationMs: randomInt(2000, 4000) });
    else if (!shortRun && choice <= 20) actions.push({ type: 'click_random_link' });
    else if (choice <= 38 && (!shortRun || actions.filter(action => action.type === 'move_mouse_randomly').length < 2)) actions.push(move());
    else actions.push(scroll(choice <= 72 ? 'scroll_down' : 'scroll_up'));
  }
  const plan = parseActionPlan(JSON.stringify(actions), maxDurationMs);
  log('plan_ready', { taskId, source: 'local', actionsCount: plan.length });
  return plan;
}
