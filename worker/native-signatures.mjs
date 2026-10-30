// Serialized into each realm. The WeakMap stays in this closure; unregistered
// functions and invalid receivers retain the realm's original toString behavior.
export function installNativeSignatures(realm = globalThis) {
  const descriptor = Object.getOwnPropertyDescriptor(realm.Function.prototype, 'toString');
  const original = descriptor.value, sources = new WeakMap();
  const replacement = new Proxy(original, {
    apply(target, receiver, args) {
      return sources.has(receiver) ? sources.get(receiver) : Reflect.apply(target, receiver, args);
    },
  });
  sources.set(replacement, Reflect.apply(original, original, []));
  Object.defineProperty(realm.Function.prototype, 'toString', { ...descriptor, value: replacement });
  return (wrapper, native) => {
    sources.set(wrapper, Reflect.apply(original, native, []));
    return wrapper;
  };
}
