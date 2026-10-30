// Browser observations confirm application of emulation, not physical hardware provenance.
function compareProfile(profile, observed) {
 const f=profile.fingerprint,n=f.navigator,s=f.screen,h=n.userAgentData;
 const rows=[];
 const add=(key,label,declared,measured)=>rows.push({key,label,declared:declared??null,observed:measured??null,status:declared==null?'unverified':measured==null?'unavailable':JSON.stringify(declared)===JSON.stringify(measured)?'matched':'mismatch'});
 add('ua','User-Agent',n.userAgent,observed.userAgent);
 add('model','Модель',h?.model,observed.clientHints?.model);
 add('os','Версия Android',h?.platformVersion,observed.clientHints?.platformVersion);
 add('platform','Платформа браузера',n.platform,observed.platform);
 add('architecture','Client Hints: архитектура',h?.architecture,observed.clientHints?.architecture);
 add('bitness','Client Hints: разрядность',h?.bitness,observed.clientHints?.bitness);
 add('cpu','Логические процессоры',n.hardwareConcurrency,observed.hardwareConcurrency);
 add('memory','Оценка памяти браузером, ГБ',n.deviceMemory,observed.memory);
 add('touch','Точек касания',n.maxTouchPoints,observed.touch);
 add('screenWidth','Ширина screen, CSS px',s.width,observed.width);
 add('screenHeight','Высота screen, CSS px',s.height,observed.height);
 add('dpr','DPR',s.devicePixelRatio,observed.dpr);
 add('availWidth','Доступная ширина, CSS px',s.availWidth,observed.availWidth);
 add('availHeight','Доступная высота, CSS px',s.availHeight,observed.availHeight);
 add('gpuVendor','WebGL vendor',f.videoCard.vendor,observed.webgl?.vendor);
 add('gpuRenderer','WebGL renderer',f.videoCard.renderer,observed.webgl?.renderer);
 for(const [key,label] of Object.entries({maxTextureSize:'WebGL: размер текстуры',maxCubeMapTextureSize:'WebGL: размер кубической текстуры',maxRenderbufferSize:'WebGL: размер renderbuffer',maxViewportDims:'WebGL: предел viewport',maxVertexAttribs:'WebGL: атрибуты вершин'}))add(key,label,f.webglLimits?.[key],observed.gpuLimits?.[key]);
 add('language','Язык',n.language,observed.language);
 add('colorScheme','Цветовая схема',f.preferences?.colorScheme,observed.preferences?.colorScheme);
 add('pointer','Основной указатель: сенсорный',profile.mobileOS==='android'?true:null,observed.mediaQueries?.pointerCoarse);
 add('hover','Без наведения',profile.mobileOS==='android'?true:null,observed.mediaQueries?.hoverNone);
 add('layoutViewport','Layout viewport',null,observed.layoutViewport);
 add('visualViewport','Visual viewport',null,observed.visualViewport);
 add('orientation','Ориентация',null,observed.orientation);
 add('connection','Network Information API',null,observed.connection);
 add('webgpu','Наличие WebGPU API',null,observed.webgpuAvailable);
 return {version:1,basis:'browser_emulation',rows,unverified:['Характеристики физического устройства и аппаратные дампы не измерены.','Шифрование снимков AES-256-GCM на уровне приложения не реализовано.','DNS, WebRTC и TLS не подтверждаются проверкой браузерных метаданных.']};
}
module.exports={compareProfile};
