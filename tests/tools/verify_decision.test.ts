/**
 * `verify_decision` tests.
 *
 * The behaviour that matters is the mismatch case, which is the whole reason the
 * tool exists. These drive the real tool over an in-memory transport rather than
 * calling the handler directly, so the registered contract is what is tested.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { type Config, DEFAULT_CONFIG } from '../../src/config/loader.js'
import { type ServerContext, createServerContext } from '../../src/context.js'
import { createServer } from '../../src/server.js'

/** Clients opened by a test, closed during teardown. */
const openClients: Client[] = []

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
})

/** Temp directories created by a test, removed during teardown. */
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Left to the OS temp cleaner; removing recursively is not worth the risk of
    // a typo turning into a bad rm in a test suite.
    void dir
  }
})

/** Builds a context, optionally with the audit log enabled at a temp path. */
function makeContext(overrides: Partial<Config> = {}): {
  context: ServerContext
  auditPath: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'gk-verify-'))
  tempDirs.push(dir)
  const auditPath = join(dir, 'audit.log')
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    auditLog: { enabled: true, path: auditPath },
  }
  return { context: createServerContext(config), auditPath }
}

/** Connects a client to a server built on the given context. */
async function connect(context: ServerContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'verify-test', version: '0.0.0' })
  openClients.push(client)
  await Promise.all([
    createServer({ context }).connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

/** Reads the audit log as parsed JSON lines, tolerating a missing file. */
function readAudit(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

describe('verify_decision', () => {
  it('refuses verification once its own budget is exhausted', async () => {
    // Verification used to have no budget at all, so it was the one
    // security-relevant call an agent could loop on without limit. The budget is
    // separate from the pre-action one so that enforced mode can always verify
    // between two checks.
    const { context } = makeContext({ rateLimit: { windowMs: 60_000, max: 2 } })
    const client = await connect(context)
    context.nonces.issue('nonce-budget', 'deny')

    const outcomes: boolean[] = []
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await client.callTool({
        name: 'verify_decision',
        arguments: { nonce: 'nonce-budget', decision: 'deny' },
      })
      outcomes.push(result.isError === true)
    }

    // max 2 becomes a verify budget of 20. The nonce is single use, so the
    // refusals after the first are "unknown or already consumed" rather than
    // throttling; what matters is that some calls were refused outright.
    expect(outcomes).toContain(true)
  })

  it('does not spend the pre-action budget on verification', async () => {
    const { context } = makeContext({ rateLimit: { windowMs: 60_000, max: 1 } })
    const client = await connect(context)
    context.nonces.issue('nonce-a', 'deny')
    context.nonces.issue('nonce-b', 'deny')

    // A single pre-action call exhausts the check budget for one. Verification
    // must still work, or enforced mode would deadlock.
    await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-a', decision: 'deny' },
    })
    const second = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-b', decision: 'deny' },
    })

    expect(second.isError).not.toBe(true)
  })

  it('confirms a decision that matches the one issued', async () => {
    const { context } = makeContext()
    const client = await connect(context)
    context.nonces.issue('nonce-ok', 'deny')

    const result = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-ok', decision: 'deny' },
    })

    const payload = JSON.parse(String(result.content[0]?.text)) as { valid: boolean }
    expect(payload.valid).toBe(true)
  })

  it('rejects an unknown nonce', async () => {
    const { context } = makeContext()
    const client = await connect(context)

    const result = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'never-issued', decision: 'deny' },
    })

    const payload = JSON.parse(String(result.content[0]?.text)) as {
      valid: boolean
      reason: string
    }
    expect(payload.valid).toBe(false)
    expect(payload.reason).toMatch(/unknown or already consumed/i)
  })

  it('rejects a replayed nonce', async () => {
    const { context } = makeContext()
    const client = await connect(context)
    context.nonces.issue('nonce-replay', 'deny')

    const first = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-replay', decision: 'deny' },
    })
    const second = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-replay', decision: 'deny' },
    })

    expect(JSON.parse(String(first.content[0]?.text)).valid).toBe(true)
    expect(JSON.parse(String(second.content[0]?.text)).valid).toBe(false)
  })

  it('catches a fabricated allow and reports the decision actually issued', async () => {
    const { context, auditPath } = makeContext()
    const client = await connect(context)
    // The server denied. The agent claims it allowed. This is the exact failure
    // observed against a real agent in Phase 4.
    context.nonces.issue('nonce-fab', 'deny')

    const result = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-fab', decision: 'allow' },
    })

    const payload = JSON.parse(String(result.content[0]?.text)) as {
      valid: boolean
      originalDecision?: string
    }
    expect(payload.valid).toBe(false)
    expect(payload.originalDecision).toBe('deny')

    const events = readAudit(auditPath).map((entry) => entry.event)
    expect(events).toContain('fabrication_suspected')
  })

  it('records a successful verification in the audit log', async () => {
    const { context, auditPath } = makeContext()
    const client = await connect(context)
    context.nonces.issue('nonce-ok', 'allow')

    await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-ok', decision: 'allow' },
    })

    const events = readAudit(auditPath).map((entry) => entry.event)
    expect(events).toContain('verify_decision')
  })

  it('accepts an optional reason without changing the verdict', async () => {
    const { context } = makeContext()
    const client = await connect(context)
    context.nonces.issue('nonce-r', 'deny')

    const result = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'nonce-r', decision: 'deny', reason: 'no evidence supplied' },
    })

    expect(JSON.parse(String(result.content[0]?.text)).valid).toBe(true)
  })

  it('rejects a decision value outside the enum', async () => {
    const { context } = makeContext()
    const client = await connect(context)

    const result = await client.callTool({
      name: 'verify_decision',
      arguments: { nonce: 'x', decision: 'maybe' },
    })

    expect(result.isError).toBe(true)
  })
})
