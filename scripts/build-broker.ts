#!/usr/bin/env bun
/**
 * Build script for broker
 * Creates a single executable
 */

import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT_FILE = join(ROOT, 'bin', 'broker')

async function build() {
  console.log('[build] Building broker...')

  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src', 'broker', 'index.ts')],
    compile: {
      outfile: OUT_FILE,
    },
    minify: true,
  })

  if (!result.success) {
    console.error('[build] Failed:')
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  console.log(`[build] Created ${OUT_FILE}`)

  // Show file size
  const stat = await Bun.file(OUT_FILE).stat()
  const sizeMB = (stat?.size || 0) / 1024 / 1024
  console.log(`[build] Size: ${sizeMB.toFixed(2)} MB`)

  // Ad-hoc codesign on macOS (required by AppleSystemPolicy on Sequoia 15.4+)
  if (process.platform === 'darwin') {
    const { spawnSync } = await import('node:child_process')
    spawnSync('codesign', ['--remove-signature', OUT_FILE], { stdio: 'inherit' })
    const sign = spawnSync('codesign', ['--force', '--sign', '-', OUT_FILE], {
      stdio: 'inherit',
    })
    if (sign.status !== 0) {
      console.error('[build] Warning: codesign failed')
    }
  }
}

build()
