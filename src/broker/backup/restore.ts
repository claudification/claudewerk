import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { extractArchive } from './compress'
import { sha256File } from './hash'
import type { BackupManifest } from './types'

function isBrokerRunning(cacheDir: string): boolean {
  const pidFile = join(cacheDir, 'broker.pid')
  if (!existsSync(pidFile)) return false
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function verifyManifest(tmpDir: string, manifest: BackupManifest): void {
  console.log('Verifying checksums...')
  for (const entry of manifest.files) {
    if (entry.sha256 === '(directory)') continue
    const filePath = join(tmpDir, entry.path)
    if (!existsSync(filePath)) throw new Error(`Missing file: ${entry.path}`)
    const actual = sha256File(filePath)
    if (actual !== entry.sha256) {
      throw new Error(
        `Checksum mismatch: ${entry.path} (expected ${entry.sha256.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`,
      )
    }
    console.log(`  ${entry.path}: OK`)
  }
}

async function restoreEntries(tmpDir: string, cacheDir: string, manifest: BackupManifest): Promise<void> {
  console.log('Restoring files...')
  for (const entry of manifest.files) {
    const srcPath = join(tmpDir, entry.path)
    if (entry.sha256 === '(directory)') {
      if (!existsSync(srcPath)) continue
      const destPath = join(cacheDir, entry.path)
      mkdirSync(destPath, { recursive: true })
      const cp = Bun.spawn(['cp', '-a', `${srcPath}/.`, destPath], { stdout: 'ignore', stderr: 'ignore' })
      await cp.exited
      console.log(`  ${entry.path} restored`)
      continue
    }
    copyFileSync(srcPath, join(cacheDir, entry.path))
    console.log(`  ${entry.path}: ${(entry.size / 1024 / 1024).toFixed(2)} MB`)
  }
}

export async function restoreBackup(archivePath: string, cacheDir: string): Promise<void> {
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`)
  if (isBrokerRunning(cacheDir)) {
    throw new Error('Broker is running -- stop it before restoring (broker.pid is active)')
  }

  const tmpDir = join(cacheDir, '_tmp_restore')
  mkdirSync(tmpDir, { recursive: true })

  try {
    console.log(`Extracting ${archivePath}...`)
    await extractArchive(archivePath, tmpDir)

    const manifestPath = join(tmpDir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error('Archive has no manifest.json -- cannot verify')
    const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

    console.log(`Backup from: ${manifest.timestamp}`)
    console.log(`Broker:      ${manifest.version.gitHashShort} (${manifest.version.branch})`)

    verifyManifest(tmpDir, manifest)
    await restoreEntries(tmpDir, cacheDir, manifest)

    console.log(`\nRestore complete. ${manifest.files.length} files from ${manifest.timestamp}`)
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}
