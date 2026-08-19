// Guarded so a file can opt into `environment: 'node'` (via a
// `@vitest-environment node` docblock) without dying here. Constructing jsdom
// is by far the most expensive thing this suite does -- 476 CPU-seconds across
// 331 files, versus 61s actually running tests -- so a pure-logic test that
// never touches the DOM should be able to skip it. Unguarded, this line made
// that impossible: every file paid for jsdom whether it needed one or not.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
