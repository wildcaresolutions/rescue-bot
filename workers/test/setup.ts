import { timingSafeEqual } from 'node:crypto'

// Polyfill crypto.subtle.timingSafeEqual — available in Workers runtime but not Node.
// crypto.subtle may be frozen/sealed in Node, so we replace it with a Proxy.
const originalSubtle = crypto.subtle
const originalRandomUUID = crypto.randomUUID?.bind(crypto)
const handler: ProxyHandler<SubtleCrypto> = {
  get(target, prop) {
    if (prop === 'timingSafeEqual') {
      return (a: ArrayBuffer, b: ArrayBuffer): boolean =>
        timingSafeEqual(Buffer.from(a), Buffer.from(b))
    }
    const val = Reflect.get(target, prop)
    return typeof val === 'function' ? val.bind(target) : val
  },
}

Object.defineProperty(globalThis, 'crypto', {
  value: {
    ...crypto,
    subtle: new Proxy(originalSubtle, handler),
    getRandomValues: crypto.getRandomValues.bind(crypto),
    // randomUUID is non-enumerable on the WebCrypto global so the spread
    // above drops it. Re-attach it explicitly so route handlers that call
    // crypto.randomUUID() (e.g. /platform/apply) work in tests.
    randomUUID: originalRandomUUID,
  },
  writable: true,
  configurable: true,
})
