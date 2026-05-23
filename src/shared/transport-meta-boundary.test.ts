import { describe, expect, it } from 'bun:test'
// The boundary lint lives in scripts/ (a dev tool). Its detection logic is pure
// and exported so the standard `bun test` suite (root = src) can verify both the
// whitelist and the rejection logic. Importing the module does NOT run the CLI
// (its main is guarded by `import.meta.main`).
import {
  findTransportMetaViolations,
  isTransportMetaReader,
  isTransportMetaReadLine,
  transportMetaReadsInFile,
} from '../../scripts/lint-boundary'

describe('lint:boundary -- transportMeta opaque-bag rule', () => {
  describe('isTransportMetaReader (whitelist)', () => {
    it('allows backend implementations', () => {
      expect(isTransportMetaReader('src/broker/backends/daemon.ts')).toBe(true)
      expect(isTransportMetaReader('src/broker/backends/claude.ts')).toBe(true)
    })

    it('allows the src/shared type-definition + refinement files', () => {
      expect(isTransportMetaReader('src/shared/spawn-schema.ts')).toBe(true)
      expect(isTransportMetaReader('src/shared/protocol.ts')).toBe(true)
    })

    it('rejects the broker core (outside backends/)', () => {
      expect(isTransportMetaReader('src/broker/spawn-dispatch.ts')).toBe(false)
      expect(isTransportMetaReader('src/broker/conversation-store.ts')).toBe(false)
      expect(isTransportMetaReader('src/broker/handlers/spawn.ts')).toBe(false)
    })

    it('rejects src/shared (outside the type definition) and web/src', () => {
      expect(isTransportMetaReader('src/shared/spawn-defaults.ts')).toBe(false)
      expect(isTransportMetaReader('web/src/components/spawn-dialog.tsx')).toBe(false)
    })
  })

  describe('isTransportMetaReadLine (read vs write vs doc)', () => {
    it('flags a `.transportMeta` property-access read', () => {
      expect(isTransportMetaReadLine('  const meta = req.transportMeta')).toBe(true)
      expect(isTransportMetaReadLine('  if (conv.transportMeta) {')).toBe(true)
    })

    it('does NOT flag an object-literal `transportMeta:` write', () => {
      expect(isTransportMetaReadLine('  transportMeta: { mode: daemonMode },')).toBe(false)
      expect(isTransportMetaReadLine('  return { backend: "daemon", transportMeta }')).toBe(false)
    })

    it('does NOT flag comment lines or string literals', () => {
      expect(isTransportMetaReadLine('  // reads conv.transportMeta later')).toBe(false)
      expect(isTransportMetaReadLine('   * the .transportMeta bag is opaque')).toBe(false)
      expect(isTransportMetaReadLine('  log("inspecting .transportMeta here")')).toBe(false)
    })
  })

  describe('transportMetaReadsInFile (per-file scan)', () => {
    const readSnippet = ['function f(req) {', '  const m = req.transportMeta', '  return m', '}'].join('\n')

    it('REJECTS a non-whitelisted reader (broker core)', () => {
      const v = transportMetaReadsInFile('src/broker/routes/spawn.ts', readSnippet)
      expect(v.length).toBe(1)
      expect(v[0].line).toBe(2)
      expect(v[0].reason).toContain('opaque bag')
    })

    it('REJECTS a non-whitelisted reader (web/src)', () => {
      const v = transportMetaReadsInFile('web/src/components/spawn-dialog.tsx', readSnippet)
      expect(v.length).toBe(1)
    })

    it('ALLOWS a whitelisted reader (backend)', () => {
      expect(transportMetaReadsInFile('src/broker/backends/daemon.ts', readSnippet).length).toBe(0)
    })

    it('ALLOWS the type-definition file', () => {
      expect(transportMetaReadsInFile('src/shared/spawn-schema.ts', readSnippet).length).toBe(0)
    })

    it('ALLOWS a pure write (no read) anywhere', () => {
      const writeSnippet = 'const req = { backend: "daemon", transportMeta: { mode: "new" } }'
      expect(transportMetaReadsInFile('web/src/components/spawn-dialog.tsx', writeSnippet).length).toBe(0)
    })
  })

  it('the real source tree has zero transportMeta boundary violations', () => {
    const violations = findTransportMetaViolations()
    if (violations.length > 0) {
      console.error('Unexpected transportMeta violations:', violations)
    }
    expect(violations).toEqual([])
  })
})
