/**
 * The no-network guarantee, enforced mechanically.
 *
 * ADR 0005 commits to GATEKEEPER MCP never phoning home. A promise in a document
 * decays silently: the day someone adds a `fetch` for a version check, nothing
 * fails and the README still says the tool is local. This test is the thing that
 * notices.
 *
 * It reads the source rather than trusting a linter, so it also catches a
 * dynamic import or a `require` of a network module that a lint rule might miss.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const srcDir = join(repoRoot, 'src')

/** Modules that can open a socket. */
const NETWORK_MODULES = [
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:http2',
  'node:cluster',
]

/** Globals that can make a request without importing a module. */
const NETWORK_GLOBALS = [
  { pattern: /\bfetch\s*\(/, label: 'fetch(' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
  { pattern: /\bnavigator\s*\.\s*sendBeacon\b/, label: 'navigator.sendBeacon' },
]

/**
 * Anything that would make the process reachable from off the machine.
 *
 * `createServer` is deliberately absent: this project has a function of that
 * name that builds the MCP server, and `node:http` is already covered by
 * {@link NETWORK_MODULES}.
 */
const LISTENER_PATTERNS = [
  { pattern: /\.listen\s*\(/, label: '.listen(' },
  { pattern: /\.bind\s*\(/, label: '.bind(' },
  { pattern: /createServer\s*\(\s*\{?\s*(?:port|host)/, label: 'http createServer({port…' },
]

/** Transports the MCP SDK offers that would make this a remote server. */
const FORBIDDEN_TRANSPORTS = [
  'SSEServerTransport',
  'StreamableHTTPServerTransport',
  'StreamableHTTPClientTransport',
  'SSEClientTransport',
]

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

/**
 * Finds a pattern in source, ignoring comment lines.
 *
 * Comments are excluded so a JSDoc paragraph describing the guarantee cannot
 * itself trip the test. The remaining false-positive risk is a string literal,
 * which is accepted: a network module named inside a string is worth a look.
 */
function findInSource(pattern: RegExp): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(srcDir)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((rawLine, index) => {
        const line = rawLine.trim()
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
          return
        }
        if (pattern.test(line)) {
          hits.push(`${file.replace(`${repoRoot}/`, '')}:${index + 1}: ${line.trim()}`)
        }
      })
  }
  return hits
}

describe('no-network guarantee', () => {
  it('imports no network-capable node module', () => {
    const offenders: string[] = []
    for (const module of NETWORK_MODULES) {
      const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      offenders.push(...findInSource(new RegExp(`from\\s+['"]${escaped}['"]`)))
      offenders.push(...findInSource(new RegExp(`require\\(\\s*['"]${escaped}['"]\\s*\\)`)))
    }

    expect(offenders, `network import found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('uses no network-capable global', () => {
    const offenders: string[] = []
    for (const { pattern, label } of NETWORK_GLOBALS) {
      const hits = findInSource(pattern)
      for (const hit of hits) {
        offenders.push(`${label} at ${hit}`)
      }
    }

    expect(offenders, `network global found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('starts no listener and opens no server socket', () => {
    // STDIO only. A `listen` anywhere in the source would mean the server could
    // be reached from off the machine, which is the opposite of the guarantee.
    const offenders: string[] = []
    for (const { pattern, label } of LISTENER_PATTERNS) {
      for (const hit of findInSource(pattern)) {
        offenders.push(`${label} at ${hit}`)
      }
    }

    expect(offenders, `listener found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('imports only the stdio transport', () => {
    // The SDK ships HTTP and SSE transports. Using one would be a remote
    // deployment, which ADR 0005 rules out.
    const offenders: string[] = []
    for (const transport of FORBIDDEN_TRANSPORTS) {
      offenders.push(...findInSource(new RegExp(transport)))
    }

    expect(offenders, `non-stdio transport found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('depends only on the three documented runtime packages', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const allowed = ['@modelcontextprotocol/sdk', 'zod', 'pino']

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(allowed.sort())
  })

  it('lists no dev-only packages as runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }

    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name, `${name} must not be a runtime dependency`).not.toMatch(/^node-/)
    }
  })
})
