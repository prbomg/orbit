import {compareProfile} from '../utils/profileComparison.js';
import { sqliteWrite } from './sqlite-write.mjs';
import { createHash } from 'node:crypto';
import { ProfileError } from './profiles.mjs';
import { clientHintHeaders } from './client-hints.mjs';
import { inspectFirstDocuments, installFirstDocumentDiagnostics } from './first-document.mjs';
import { inspectContextMatrix } from './context-matrix.mjs';
import { readNativeBaseline } from './native-baseline.mjs';
import { motionDiagnostics } from './motion-emulation.mjs';
import { canvasProfileOptions } from './canvas-profile.mjs';
import { webglLimitSources } from './webgl-limits.mjs';
import {observeNetworkTransport,observeHttp3,reserveTransportProbe,transportReference,unmeasuredTransport,networkProbeUrl} from './network-transport.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function inspectFingerprint(page, profile, previous, runtimeVersion, { nativeBaseline } = {}) {
  const firstDocuments = await inspectFirstDocuments(page, profile);
  const baseline = nativeBaseline || await readNativeBaseline(page.context().browser());
  const contextMatrix = await inspectContextMatrix(page, profile, { baseline });
  const url = 'https://orbit-fingerprint.invalid/';

  let observed;
  {
    const dispose = await installFirstDocumentDiagnostics(page.context());
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
    finally { await dispose(); }
    observed = await page.evaluate(async fonts => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 70;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d57321'; ctx.fillRect(0, 0, 240, 70); ctx.font = '18px sans-serif'; ctx.fillStyle = '#172a9c'; ctx.fillText('Orbit device check 012345', 5, 35);
      const gl = document.createElement('canvas').getContext('webgl'), ext = gl?.getExtension('WEBGL_debug_renderer_info');
      let audio = null;
      try { const ac = new OfflineAudioContext(1, 4096, 44100), osc = ac.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 1000; osc.connect(ac.destination); osc.start(); const result = await ac.startRendering(); audio = Array.from(result.getChannelData(0).slice(0, 256), v => Number(v.toFixed(7))); } catch {}
      const availableFonts = fonts.filter(font => {
        const probe = 'mmmmmmmmmmlliWW012345';
        return ['monospace', 'serif', 'sans-serif'].some(base => { ctx.font = `72px ${base}`; const a = ctx.measureText(probe).width; ctx.font = `72px "${font.replace(/["\\]/g, '')}", ${base}`; return ctx.measureText(probe).width !== a; });
      });
      let battery = null;
      try { if (navigator.getBattery) { const b = await navigator.getBattery(); battery = { level: b.level, charging: b.charging }; } } catch {}
      const api = Object.fromEntries(['MediaSource','RTCPeerConnection','DeviceMotionEvent','DeviceOrientationEvent','AudioContext','OfflineAudioContext','WebGLRenderingContext'].map(name => [name, typeof window[name] !== 'undefined']));
      const codecs = ['video/mp4; codecs="avc1.42E01E"','video/webm; codecs="vp9"','audio/mp4; codecs="mp4a.40.2"','audio/webm; codecs="opus"'].map(type => ({ type, canPlayType: document.createElement(type.startsWith('video') ? 'video' : 'audio').canPlayType(type), mediaSource: typeof MediaSource !== 'undefined' ? MediaSource.isTypeSupported(type) : null }));
      const readLimits = gl => gl ? { maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE), maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []), maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
        maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS), maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS), maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS), maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
        ...(typeof gl.MAX_VERTEX_UNIFORM_COMPONENTS === 'number' ? { maxVertexUniformComponents: gl.getParameter(gl.MAX_VERTEX_UNIFORM_COMPONENTS), maxFragmentUniformComponents: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_COMPONENTS), maxUniformBufferBindings: gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) } : {}) } : null;
      const gpuLimits = readLimits(gl);
      const gl2 = document.createElement('canvas').getContext('webgl2');
      const gpuLimitsWebgl2 = readLimits(gl2);
      const clientHints = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['model','platformVersion','architecture','bitness','fullVersionList']) : null;
      return { platform:navigator.platform, availWidth:screen.availWidth, availHeight:screen.availHeight, layoutViewport:{width:innerWidth,height:innerHeight}, visualViewport:window.visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}:null, webgpuAvailable:typeof navigator.gpu!=='undefined', mediaQueries: { pointerCoarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches }, orientation: screen.orientation?.type || null, connection: navigator.connection ? { effectiveType: navigator.connection.effectiveType, rtt: navigator.connection.rtt, downlink: navigator.connection.downlink, saveData: navigator.connection.saveData } : null, api, codecs, gpuLimits, clientHints, userAgent: navigator.userAgent, language: navigator.language, hardwareConcurrency: navigator.hardwareConcurrency, memory: navigator.deviceMemory ?? null, touch: navigator.maxTouchPoints, width: screen.width, height: screen.height, dpr: devicePixelRatio, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        preferences:{colorScheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches?'reduce':'no-preference',contrast:matchMedia('(prefers-contrast: more)').matches?'more':matchMedia('(prefers-contrast: less)').matches?'less':'no-preference'},
        gpuLimitsWebgl2, webglExtensions: { webgl: gl?.getSupportedExtensions()?.slice().sort() ?? null, webgl2: gl2?.getSupportedExtensions()?.slice().sort() ?? null }, webgl: ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : null, canvas: canvas.toDataURL(), audio, availableFonts, battery };
    }, (profile.fingerprint.fonts || []).slice(0, 100));
  }
  const f = profile.fingerprint, n = f.navigator, s = f.screen;
  const checks = { firstDocuments: firstDocuments.status === 'passed', userAgent: observed.userAgent === n.userAgent, language: observed.language === n.language, cpu: observed.hardwareConcurrency === n.hardwareConcurrency, screen: observed.width === s.width && observed.height === s.height && observed.dpr === s.devicePixelRatio, touch: observed.touch === n.maxTouchPoints,
    webgl: observed.webgl?.vendor === f.videoCard.vendor && observed.webgl?.renderer === f.videoCard.renderer,
    ...(f.webglLimits ? { webglLimits: [observed.gpuLimits, observed.gpuLimitsWebgl2].every((actual, index) => Object.entries(f.webglLimits).filter(([key]) => index === 1 || !['maxVertexUniformComponents','maxFragmentUniformComponents'].includes(key)).every(([key, value]) => JSON.stringify(actual?.[key]) === JSON.stringify(value))) } : {}),
    ...(f.preferences?{preferences:Object.entries(f.preferences).every(([key,value])=>observed.preferences?.[key]===value)}:{}),
    ...(profile.passport?.timezone ? { timezone: observed.timezone === new Intl.DateTimeFormat('en', { timeZone: profile.passport.timezone }).resolvedOptions().timeZone } : {}),
    ...(profile.mobileOS === 'android' ? { memory: observed.memory === n.deviceMemory } : {}) };
  const audioHash = observed.audio ? hash(observed.audio) : null, canvasHash = hash(observed.canvas);
  const warnings = [];
  if (contextMatrix.apiBehavior.status === 'differences') warnings.push(`Поведение API отличается от контрольного браузера: ${contextMatrix.apiBehavior.differences} различий дескрипторов, функций, ошибок или шрифтов. Диагностика не подтверждает нативность эмуляции.`);
  if (contextMatrix.apiBehavior.status === 'incomplete') warnings.push('Сравнение поведения API с контрольным браузером выполнено не полностью; нативность не подтверждена.');
  if (contextMatrix.status !== 'passed') warnings.push(`Матрица контекстов: ${contextMatrix.summary.mismatches} расхождений, ${contextMatrix.summary.errors} ошибок измерения. Проверка диагностическая, запуск не блокирует.`);
  if (observed.codecs.some(c => c.canPlayType && c.mediaSource === false)) warnings.push('Часть заявленных медиакодеков недоступна в MediaSource установленного движка');
  if (n.userAgentData && profile.headers['sec-ch-ua'] !== clientHintHeaders(n.userAgentData)['sec-ch-ua']) warnings.push('HTTP Client Hints прежнего профиля согласованы с метаданными его браузера');
  if (!observed.mediaQueries.pointerCoarse || !observed.mediaQueries.hoverNone) warnings.push('Медиа-запросы ввода не соответствуют сенсорному мобильному сценарию');
  if (!audioHash) warnings.push('Аудио-измерение недоступно');
  if ((f.fonts || []).some(font => !observed.availableFonts.includes(font))) warnings.push('Часть заявленных шрифтов отсутствует в браузере');
  if (profile.mobileOS === 'ios') warnings.push('Старый iOS-профиль выполняется в Chromium; точное соответствие iOS невозможно');
  const declaredMajor = n.userAgent.match(/(?:Chrome|CriOS)\/(\d+)/)?.[1];
  if (declaredMajor && declaredMajor !== runtimeVersion.split('.')[0]) warnings.push('Версия браузера в старом отпечатке отличается от установленной');
  // Detect unexpected identity drift within the same engine version.
  if (previous?.status === 'passed' && previous.runtimeVersion === runtimeVersion) {
    checks.canvasStable = previous.canvasHash === canvasHash;
    if (previous.audioHash && audioHash) checks.audioStable = previous.audioHash === audioHash;
  }
  const checkedAt = new Date().toISOString();
  const graphics = { canvasMode: canvasProfileOptions(profile).mode,
    canvasSource: f.canvas?.mode === 'native' ? 'browser-runtime' : 'legacy-seeded-readout',
    webglLimitsSource: f.webglLimits ? 'catalog-emulation' : 'browser-runtime',
    ...webglLimitSources(f.webglLimits) };
  const main = contextMatrix.records.find(r => r.scene === 'main')?.observed;
  if (graphics.uniformLimitsSource !== 'catalog-emulation') warnings.push('Uniform/varying-лимиты полностью или частично взяты из браузера; соответствие заявленному GPU не подтверждено.');
  return { version: 5, graphics, comparison:compareProfile(profile,observed), firstDocuments, contextMatrix: { ...contextMatrix, enforcement: 'diagnostic' }, declared: { fonts: f.fonts || [], gpu: f.videoCard, clientHints: n.userAgentData || null, audioCodecs: f.audioCodecs || {}, videoCodecs: f.videoCodecs || {} }, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checkedAt, runtimeVersion, checks, warnings, audioHash, canvasHash,
    dynamic: { battery: { mode: 'simulated', observedAt: checkedAt, supported: Boolean(observed.battery), ...observed.battery },
      motion: { ...motionDiagnostics(page), checkedAt } },
    observed: { ...observed, shaderPrecision: { webgl: main?.documentCanvas?.webgl?.shaderPrecision ?? null, webgl2: main?.documentCanvas?.webgl2?.shaderPrecision ?? null }, audio: undefined, canvas: undefined } };
}
export async function verifyFingerprint({ prisma, page, profile, runtimeVersion, network, transportOptions }) {
  const row = await prisma.profile.findUniqueOrThrow({ where: { id: profile.profileId } });
  const baseline = await prisma.fingerprintMeasurement.findFirst({ where: { profileId: profile.profileId, runtimeVersion, status: 'passed' }, orderBy: { createdAt: 'desc' } });
  const previous = baseline?.report || row.fingerprintCheck;
  const result = await inspectFingerprint(page, profile, previous, runtimeVersion);
  const older = previous?.runtimeVersion && previous.runtimeVersion !== runtimeVersion ? previous : await prisma.fingerprintMeasurement.findFirst({ where: { profileId: profile.profileId, runtimeVersion: { not: runtimeVersion }, status: 'passed' }, orderBy: { createdAt: 'desc' } }).then(v => v?.report);
  result.engineChange = older ? { previousVersion: older.runtimeVersion, canvasChanged: older.canvasHash !== result.canvasHash, audioChanged: older.audioHash !== result.audioHash, requiresVerification: true } : null;
  if (older) result.warnings.push('Движок обновлён: измерения сохранены отдельно для каждой версии Chromium');
  result.network = { ...(network || {status:'pending'}), transport:unmeasuredTransport() };
  if (result.status==='passed' && transportOptions?.endpoint) {
    let transport;
    try {
      if(await reserveTransportProbe(prisma,transportOptions.endpoint)) {
        const reference=await transportReference(transportOptions.referenceFile,{runtimeVersion,locale:profile.fingerprint.navigator.language,endpointHost:networkProbeUrl(transportOptions.endpoint).host});
        transport=await observeNetworkTransport(page.context(),profile,{...transportOptions,runtimeVersion,reference});
        if(transportOptions.http3Endpoint&&!transportOptions.signal?.aborted)transport.http3=await observeHttp3(page.context(),{endpoint:transportOptions.http3Endpoint,timeoutMs:Math.min(8000,transportOptions.timeoutMs),signal:transportOptions.signal});
      } else transport=unmeasuredTransport('probe_throttled');
    }catch{transport=unmeasuredTransport('probe_unavailable');}
    result.network.transport=transport;
    if(transport.comparison.status!=='matched')result.warnings.push('Соответствие TLS/HTTP2 нативному Android Chrome не подтверждено. Сетевое измерение диагностическое.');
  }
  const safe = JSON.parse(JSON.stringify(result));
  await sqliteWrite(prisma, async tx => {
    if (!baseline && row.fingerprintCheck?.status === 'passed' && typeof row.fingerprintCheck.runtimeVersion === 'string' && Number.isFinite(new Date(row.fingerprintCheck.checkedAt).getTime())) await tx.fingerprintMeasurement.create({ data: { profileId: profile.profileId, runtimeVersion: row.fingerprintCheck.runtimeVersion, status: 'passed', report: row.fingerprintCheck, createdAt: new Date(row.fingerprintCheck.checkedAt) } });
    await tx.fingerprintMeasurement.create({ data: { profileId: profile.profileId, runtimeVersion, status: result.status, report: safe } });
    await tx.profile.update({ where: { id: profile.profileId }, data: { fingerprintState: result.status === 'passed' ? 'verified' : 'failed', fingerprintCheck: safe } });
  });
  if (result.status !== 'passed') throw new ProfileError('fingerprint_verification_failed');
  return result;
}
