/**
 * Server wiring tests.
 *
 * The server is exercised over an in-memory transport pair rather than a real
 * process, so these tests cover tool registration without spawning a child or
 * touching the JSON-RPC stream on stdout.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'

import { createServer } from '../src/server.js'
import { PRE_ACTION_CHECK_TOOL_NAME } from '../src/tools/pre_action_check.js'
import { VERIFY_DECISION_TOOL_NAME } from '../src/tools/verify_decision.js'

/** Clients opened by a test, closed during teardown. */
const openClients: Client[] = []

/**
 * Connects an in-memory client to a server and completes initialization.
 *
 * @param server The server under test.
 * @returns The connected client.
 */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'gatekeeper-test-client', version: '0.0.0' })

  openClients.push(client)
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
})

describe('createServer', () => {
  it('returns an McpServer instance named gatekeeper-mcp', async () => {
    const server = createServer()

    expect(server).toBeInstanceOf(McpServer)

    const client = await connectClient(server)
    expect(client.getServerVersion()?.name).toBe('gatekeeper-mcp')
  })

  it('exposes pre_action_check in the tool list', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const { tools } = await client.listTools()
    const toolNames = tools.map((tool) => tool.name)

    expect(toolNames).toContain(PRE_ACTION_CHECK_TOOL_NAME)
  })

  it('exposes verify_decision in the tool list', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain(VERIFY_DECISION_TOOL_NAME)
  })

  it('issues a nonce on every pre_action_check response', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const result = await client.callTool({
      name: PRE_ACTION_CHECK_TOOL_NAME,
      arguments: { taskDescription: 'Add a retry', proposedChange: 'Wrap the call.' },
    })
    const payload = JSON.parse(String(result.content[0]?.text)) as { nonce?: string }

    expect(typeof payload.nonce).toBe('string')
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('advertises the reproduction input in the tool description', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === PRE_ACTION_CHECK_TOOL_NAME)

    // The description is the agent's only instruction before it decides whether
    // to supply an executable reproduction, so it has to mention it.
    expect(tool?.description).toContain('reproduction')
  })

  it('publishes the Phase 2 input fields in the tool schema', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === PRE_ACTION_CHECK_TOOL_NAME)
    const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties

    expect(Object.keys(properties ?? {}).sort()).toEqual(
      [
        'affectedFiles',
        'evidenceOfProblem',
        'reproduction',
        'taskDescription',
        'proposedChange',
      ].sort(),
    )
  })

  it('no longer advertises the runTests opt-out', async () => {
    // The flag let the agent decide whether its claim got cross-checked, which
    // combined with the agent also choosing the reproduction command to make
    // `allow` free. It must not reappear in the advertised contract.
    const server = createServer()
    const client = await connectClient(server)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === PRE_ACTION_CHECK_TOOL_NAME)
    const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties

    expect(properties ?? {}).not.toHaveProperty('runTests')
  })

  it('does not put the denylist in the advertised schema, so rejections stay auditable', async () => {
    // The SDK validates arguments against the advertised schema before the
    // handler runs. A denylist folded in here made `denylist_rejected` events
    // unreachable, leaving the audit trail blind to the commonest rejection.
    const server = createServer()
    const client = await connectClient(server)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === PRE_ACTION_CHECK_TOOL_NAME)
    const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties
    const reproduction = properties?.reproduction as
      | { properties?: Record<string, unknown> }
      | undefined

    // Shape is advertised: the fields an agent has to know about.
    expect(Object.keys(reproduction?.properties ?? {}).sort()).toEqual(
      ['args', 'command', 'cwd', 'expectFailure', 'timeoutMs'].sort(),
    )
  })
})

describe('pre_action_check over MCP', () => {
  it('denies a call that supplies no evidence', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const result = await client.callTool({
      name: PRE_ACTION_CHECK_TOOL_NAME,
      arguments: { taskDescription: 'Add a retry', proposedChange: 'Wrap the call.' },
    })

    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(String(result.content[0]?.text))
    expect(payload.decision).toBe('deny')
    expect(payload.evidence.state).toBe('unverifiable')
  })

  it('asks for an executable reproduction when given free text only', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const result = await client.callTool({
      name: PRE_ACTION_CHECK_TOOL_NAME,
      arguments: {
        taskDescription: 'Fix the crash',
        proposedChange: 'Guard the null case.',
        evidenceOfProblem: 'It crashes on start-up.',
      },
    })

    const payload = JSON.parse(String(result.content[0]?.text))
    expect(payload.decision).toBe('request_info')
  })

  it('returns a tool error, not a protocol fault, for invalid input', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const result = await client.callTool({
      name: PRE_ACTION_CHECK_TOOL_NAME,
      // `proposedChange` is required, so this must be rejected at the boundary.
      arguments: { taskDescription: 'Add a retry' },
    })

    expect(result.isError).toBe(true)
    // The failure message must not leak internals.
    expect(String(result.content[0]?.text)).not.toMatch(/at .*\.ts:\d+/)
  })

  it('rejects a reproduction command containing shell syntax', async () => {
    const server = createServer()
    const client = await connectClient(server)

    const result = await client.callTool({
      name: PRE_ACTION_CHECK_TOOL_NAME,
      arguments: {
        taskDescription: 'Fix the crash',
        proposedChange: 'Guard the null case.',
        reproduction: { command: 'npm test && echo done' },
      },
    })

    const payload = JSON.parse(String(result.content[0]?.text))
    expect(payload.evidence.state).toBe('unverifiable')
    expect(payload.evidence.detail).toMatch(/metacharacters/i)
  })
})
