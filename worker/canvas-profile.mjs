/** Deterministic sparse changes on exported pixels; visible canvas rendering is untouched. */
export function installCanvasProfile({ seed, ios }) {
  if (ios) Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true });
  const canvasPrototype = HTMLCanvasElement.prototype;
  const contextPrototype = CanvasRenderingContext2D.prototype;
  const nativeGet = contextPrototype.getImageData;
  const nativePut = contextPrototype.putImageData;
  const nativeDraw = contextPrototype.drawImage;
  const nativeContext = canvasPrototype.getContext;
  const hash = value => {
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return (value ^ (value >>> 16)) >>> 0;
  };
  function perturb(image, startX, startY, width, height) {
    if (!width || !height || !(image.data instanceof Uint8ClampedArray)) return image;
    for (let i = 0; i < 8; i++) {
      const x = hash(seed + i * 2) % width - startX;
      const y = hash(seed + i * 2 + 1) % height - startY;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const index = (y * image.width + x) * 4;
      if (!image.data[index + 3]) continue;
      const channel = hash(seed ^ i) % 3;
      const original = image.data[index + channel];
      image.data[index + channel] = original === 255 ? 254 : original + 1;
    }
    return image;
  }
  contextPrototype.getImageData = new Proxy(nativeGet, {
    apply(target, receiver, args) {
      const image = Reflect.apply(target, receiver, args);
      return perturb(image, Math.trunc(Number(args[0])), Math.trunc(Number(args[1])), receiver.canvas.width, receiver.canvas.height);
    },
  });
  function exportedCopy(canvas) {
    if (!canvas.width || !canvas.height) return canvas;
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
    const context = Reflect.apply(nativeContext, copy, ['2d']);
    Reflect.apply(nativeDraw, context, [canvas, 0, 0]);
    const pixels = Reflect.apply(nativeGet, context, [0, 0, copy.width, copy.height]);
    Reflect.apply(nativePut, context, [perturb(pixels, 0, 0, copy.width, copy.height), 0, 0]);
    return copy;
  }
  for (const method of ['toDataURL', 'toBlob']) {
    const native = canvasPrototype[method];
    canvasPrototype[method] = new Proxy(native, {
      apply(target, receiver, args) { return Reflect.apply(target, exportedCopy(receiver), args); },
    });
  }
}
