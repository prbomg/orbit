export const resourceWait: Record<string,string> = { no_ready_profiles: 'Нет готового профиля, подходящего для новой попытки', no_active_proxies: 'Нет активных прокси для задач', profiles_busy: 'Подходящие профили заняты', proxies_busy: 'Подходящие каналы прокси заняты или на паузе', proxy_replacement_unavailable: 'Нет доступного другого канала прокси после ошибки', pair_incompatible: 'Готовые профили несовместимы с доступными прокси', retry_pause: 'Пауза перед повторной попыткой', profiles_or_proxies: 'Ожидание ресурсов: причины различаются между задачами' };
import type { Task, SystemState } from '@/lib/data-store';
import { taskState, nextTaskWindow } from '@/utils/dashboardState';
export const taskErrorText = (code?: string | null) => ({search_navigation_unstable:'Страница продолжает переходы; проверка интерфейса не завершена',stopped:'Остановлена пользователем',search_rate_limited:'HTTP 429: ограничение частоты запросов',ERROR_CAPTCHA_UNSOLVABLE:'Сервис капчи не распознал задание',solve_limit:'Достигнут лимит платных решений капчи',incorrect_limit:'Достигнут лимит некорректных решений',worker_interrupted:'Исполнитель был прерван',proxy_check_failed:'Прокси не открыл сайт',ERROR_SUBMIT_TIMEOUT:'Сервис капчи не ответил при отправке задания',image_capture_failed:'Не удалось получить изображение капчи'} as Record<string,string>)[code||''] || code || '';
export function taskPresentation(task:Task,system:SystemState|null) {
  const run=system?.projectRuns?.find(r=>r.projectId===task.projectId)||(system?.projectRun?.projectId===task.projectId?system.projectRun:undefined);
  const state=taskState(task,run);
  const attention=state.kind==='error'||state.kind==='retry'||state.kind==='resources'||task.status==='running'&&(task.retryState?.count||0)>0;
  const next=task.project?nextTaskWindow(task.project,task,run):null;
  return {state,attention,next,code:state.code||task.retryState?.code};
}
export function taskTime(value:string,zone='Europe/Moscow'){return new Date(value).toLocaleString('ru-RU',{timeZone:zone,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
