/** New identities use native Canvas. Retain seeded readout only for saved legacy identities. */
export function canvasProfileOptions(profile) {
  const policy = profile.fingerprint?.canvas;
  if (policy && (policy.version !== 1 || policy.mode !== 'native')) throw Error('invalid_canvas_policy');
  return { seed: profile.canvasSeed, ios: profile.mobileOS === 'ios', mode: policy ? 'native' : 'legacy-seeded-v1' };
}

export function installCanvasProfile({ seed, ios, mode = 'legacy-seeded-v1' }) {
  if (!['native', 'legacy-seeded-v1'].includes(mode)) throw Error('invalid_canvas_policy');
  if (ios && typeof Navigator !== 'undefined') Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true });
  if (mode === 'native') return;
  
  const hash = value => {
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return (value ^ (value >>> 16)) >>> 0;
  };
  
  function perturb(image, startX, startY, width, height) {
    if (!width || !height || !(image.data instanceof Uint8ClampedArray)) return image;
    const count = 12 + (hash(seed ^ width ^ height) % 25); // 12..36 псевдо-случайных точек на холст
    for (let i = 0; i < count; i++) {
      const x = hash(seed + i * 3) % width - startX;
      const y = hash(seed + i * 3 + 1) % height - startY;
      if (x < 0 || y < 0 || x >= image.width || x >= image.height) continue;
      const index = (y * image.width + x) * 4;
      if (!image.data[index + 3]) continue;
      const channel = hash(seed ^ i) % 3;
      const delta = (hash(seed + i * 7) & 1) ? 1 : -1;
      const original = image.data[index + channel];
      image.data[index + channel] = original === 255 ? 254 : original === 0 ? 1 : original + delta;
    }
    return image;
  }
  
  const families = [];
  if (typeof HTMLCanvasElement !== 'undefined' && typeof CanvasRenderingContext2D !== 'undefined') families.push({ Canvas: HTMLCanvasElement, Context: CanvasRenderingContext2D, methods: ['toDataURL', 'toBlob'], create: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; } });
  if (typeof OffscreenCanvas !== 'undefined' && typeof OffscreenCanvasRenderingContext2D !== 'undefined') families.push({ Canvas: OffscreenCanvas, Context: OffscreenCanvasRenderingContext2D, methods: ['convertToBlob'], create: (w, h) => new OffscreenCanvas(w, h) });
  
  for (const { Canvas, Context, methods, create } of families) {
    const canvasPrototype = Canvas.prototype, contextPrototype = Context.prototype;
    const nativeGet = contextPrototype.getImageData, nativePut = contextPrototype.putImageData;
    const nativeDraw = contextPrototype.drawImage, nativeContext = canvasPrototype.getContext;
    
    contextPrototype.getImageData = new Proxy(nativeGet, {
      apply(target, receiver, args) {
        const image = Reflect.apply(target, receiver, args);
        const sx = Math.trunc(Number(args[0])), sy = Math.trunc(Number(args[1]));
        const sw = Math.trunc(Number(args[2])), sh = Math.trunc(Number(args[3]));
        return perturb(image, sw < 0 ? sx + sw : sx, sh < 0 ? sy + sh : sy, receiver.canvas.width, receiver.canvas.height);
      },
    });
    
    function exportedCopy(canvas) {
      const width = Reflect.apply(Object.getOwnPropertyDescriptor(canvasPrototype, 'width').get, canvas, []);
      const height = Reflect.apply(Object.getOwnPropertyDescriptor(canvasPrototype, 'height').get, canvas, []);
      if (!width || !height) return canvas;
      const copy = create(width, height), context = Reflect.apply(nativeContext, copy, ['2d']);
      Reflect.apply(nativeDraw, context, [canvas, 0, 0]);
      const pixels = Reflect.apply(nativeGet, context, [0, 0, width, height]);
      Reflect.apply(nativePut, context, [perturb(pixels, 0, 0, width, height), 0, 0]);
      return copy;
    }
    
    for (const method of methods) {
      const native = canvasPrototype[method];
      canvasPrototype[method] = new Proxy(native, {
        apply(target, receiver, args) {
          if (method === 'convertToBlob') {
            const validation = Reflect.apply(target, receiver, args);
            let copy;
            try { copy = exportedCopy(receiver); }
            catch (error) { return validation.then(() => { throw error; }); }
            return validation.then(() => Reflect.apply(target, copy, args));
          }
          return Reflect.apply(target, exportedCopy(receiver), args);
        },
      });
    }
  }
}