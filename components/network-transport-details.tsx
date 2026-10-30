"use client";
import type {TransportQuality} from '@/lib/profile-quality';
export function NetworkTransportDetails({transport}:{transport?:TransportQuality|null}) {
  if(!transport)return null;
  return (transport && <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Сетевой транспорт: TLS / HTTP2 / HTTP3</summary><div className="mt-3 space-y-2">
      <p>Измерение: {transport.status === 'measured' ? 'выполнено' : transport.reason === 'probe_throttled' ? 'отложено на время ограничения частоты' : transport.status === 'unavailable' ? 'сервис недоступен или ответ не прошёл проверку' : 'не выполнено'}{transport.collectorHttpStatus ? ` · HTTP ${transport.collectorHttpStatus}` : ''}</p>
      {transport.errorCode && <p className="text-xs">Код диагностики: {transport.errorCode}</p>}
      <p>Коллектор: {transport.collectorHost || 'не настроен'} · {transport.checkedAt ? new Date(transport.checkedAt).toLocaleString('ru-RU') : 'измерение не выполнено'}</p>
      <p className="break-all">JA4: {transport.tls.ja4 || 'не измерен'}</p>
      <p className="break-all">HTTP/2 (orbit-h2-v1): {transport.http2.fingerprint || 'не измерен'}</p>
      {transport.http2.settings && <pre className="overflow-x-auto text-xs">{JSON.stringify({settings:transport.http2.settings,windowUpdates:transport.http2.windowUpdates,pseudoHeaderOrder:transport.http2.pseudoHeaderOrder},null,2)}</pre>}
      <p>HTTP/3: {transport.http3.status === 'observed' ? 'наблюдался' : transport.http3.status === 'not_observed' ? 'не наблюдался; переход на TCP допустим' : 'не измерен'}</p>
      <p>Эталон Android: {transport.comparison.status === 'matched' ? 'отпечатки совпали с предоставленным эталоном' : transport.comparison.status === 'different' ? 'есть расхождения' : 'соответствие не подтверждено'}</p>
      <p className="text-xs text-muted-foreground">Сравнение диагностическое. HTTP/2 SETTINGS измеряются отдельно от JA4H. Повторное открытие страницы не доказывает новое TLS-рукопожатие. Физическое Android-устройство не подтверждено.</p>
    </div></details>);
}
