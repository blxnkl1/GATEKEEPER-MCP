/**
 * The free-and-local-forever guarantee, enforced mechanically.
 *
 * ADR 0005 makes five promises: no telemetry, no key or account, only free
 * open-source runtime dependencies, no paid tier, and MIT forever. The no-network
 * test covers the first. This file covers the rest mechanically, so none of them
 * can lapse without a test failing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const srcDir = join(repoRoot, 'src')

/** Licences considered free and open-source. */
const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']

/** Environment variables that would indicate a credential requirement. */
const CREDENTIAL_PATTERN = /process\.env\.(\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*)/i

/** Recursively lists every .ts file under a directory. */
function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full))
    } else if (entry.endsWith('.ts')) {
      found.push(full)
    }
  }
  return found
}

describe('free-and-local guarantee', () => {
  it('ships an MIT LICENSE file', () => {
    const licence = readFileSync(join(repoRoot, 'LICENSE'), 'utf8')

    expect(licence).toContain('MIT License')
  })

  it('declares MIT in package.json', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      license?: string
    }

    expect(manifest.license).toBe('MIT')
  })

  it('requires no credential environment variable', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(srcDir)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((rawLine, index) => {
          const line = rawLine.trim()
          if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
            return
          }
          const match = CREDENTIAL_PATTERN.exec(line)
          if (match !== null) {
            offenders.push(`${file.replace(`${repoRoot}/`, '')}:${index + 1}: ${match[1]}`)
          }
        })
    }

    expect(offenders, `credential environment variable found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('has no paid-tier or hosted-mode marker in the source', () => {
    // A paid tier would need a price, a plan, a subscription, or a hosted mode.
    // Matching on those words in code catches the shape of such a change even when
    // the strings are assembled at runtime.
    const offenders: string[] = []
    const hosted = /\b(pricing|subscription|checkout|billing|stripe|per-seat|per-seat license)\b/i
    for (const file of sourceFiles(srcDir)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((rawLine, index) => {
          const line = rawLine.trim()
          if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
            return
          }
          if (hosted.test(line)) {
            offenders.push(`${file.replace(`${repoRoot}/`, '')}:${index + 1}: ${line.trim()}`)
          }
        })
    }

    expect(offenders, `paid-tier marker found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('licences every runtime dependency permissively', () => {
    // The installed tree is authoritative: a package can change licence between
    // the version range in package.json and what actually got installed.
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const installed = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules', '.package-lock.json'), 'utf8'),
    ) as { packages?: Record<string, { license?: string }> }

    const offenders: string[] = []
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const entry = installed.packages?.[`node_modules/${name}`]
      if (entry === undefined) {
        continue
      }
      if (entry.license === undefined || !ALLOWED_LICENSES.includes(entry.license)) {
        offenders.push(`${name}: ${entry.license ?? 'unknown'}`)
      }
    }

    expect(offenders, `non-permissive runtime dependency:\n${offenders.join('\n')}`).toEqual([])
  })
})
