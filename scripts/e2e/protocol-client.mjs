/**
 * Minimal MCP stdio client for the protocol test: JSON-RPC framing only, no SDK,
 * no network, no LLM. "Does the server speak MCP correctly?" and "does an agent
 * obey it?" fail independently, so they are tested separately.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = resolve(process.argv[2] ?? resolve(root, 'dist/index.js'))
const PROTOCOL = '2025-06-18'
const TOOL = 'pre_action_check'

if (!existsSync(entry)) {
  process.stderr.write(`entrypoint not found: ${entry}\n`)
  process.exit(1)
}
const checks = []
const record = (name, ok, detail = '') => checks.push({ name, ok, detail })
const child = spawn('node', [entry], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
// Logs go to stderr by design. Captured for diagnostics, never for stdout.
let serverStderr = ''
child.stderr.on('data', (chunk) => {
  serverStderr += chunk.toString()
})
let buffer = ''
let frames = 0
let stdoutWasPureJson = true
let nextId = 0
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (line === '') continue
    frames += 1
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // A non-JSON line on stdout is a protocol violation: that stream is JSON-RPC only.
      stdoutWasPureJson = false
      continue
    }
    const resolver = pending.get(message.id)
    if (resolver !== undefined) {
      pending.delete(message.id)
      resolver(message)
    }
  }
})
function send(method, params) {
  return new Promise((done) => {
    const id = ++nextId
    pending.set(id, done)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
// Rejects rather than hangs, so a wedged server cannot stall the caller.
function deadline(promise, ms, label) {
  let timer
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}
try {
  const init = await deadline(
    send('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'gk-protocol-test', version: '0.0.0' },
    }),
    10_000,
    'initialize',
  )
  if (init.error !== undefined || init.result === undefined) {
    record('initialize returns a result', false, JSON.stringify(init.error ?? 'no result'))
  } else {
    const info = init.result.serverInfo ?? {}
    record('initialize returns a result', true, `${info.name} ${info.version}`)
    record(
      'server identifies as gatekeeper-mcp',
      info.name === 'gatekeeper-mcp',
      `name=${info.name}`,
    )
  }
  notify('notifications/initialized', {})
  const list = await deadline(send('tools/list', {}), 10_000, 'tools/list')
  const tools = list.result?.tools ?? []
  const tool = tools.find((candidate) => candidate.name === TOOL)
  record(`tools/list advertises ${TOOL}`, tool !== undefined, `${tools.length} tool(s)`)
  record(`${TOOL} has an input schema`, tool?.inputSchema !== undefined)
  // No evidence at all, so the only correct answer is deny. If it ever allows, the gate is open.
  const call = await deadline(
    send('tools/call', {
      name: TOOL,
      arguments: { taskDescription: 'test', proposedChange: 'noop', affectedFiles: [] },
    }),
    15_000,
    'tools/call',
  )
  if (call.error !== undefined) {
    record('tools/call returns a result', false, JSON.stringify(call.error))
  } else {
    record('tools/call returns a result', true, 'ok')
  }
  const text = call.result?.content?.[0]?.text
  record('tool result is text', typeof text === 'string', typeof text)
  if (typeof text === 'string') {
    // Pretty-printed on the wire, so check a whitespace-stripped copy.
    const compact = text.replace(/\s+/g, '')
    record('response contains "decision":"deny"', compact.includes('"decision":"deny"'))
    record('response contains "state":"unverifiable"', compact.includes('"state":"unverifiable"'))
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      record('response is valid JSON', false)
    }
    if (parsed !== undefined) {
      const steps = Array.isArray(parsed.nextSteps) ? parsed.nextSteps.length : 0
      record('response is valid JSON', true)
      record('decision is deny', parsed.decision === 'deny', `decision=${parsed.decision}`)
      record('evidence state is unverifiable', parsed.evidence?.state === 'unverifiable')
      record('response includes a reason', typeof parsed.reason === 'string' && !!parsed.reason)
      record('response includes next steps', steps > 0, `${steps} step(s)`)

      // The anti-fabrication handshake. A nonce is only worth something if it can
      // be spent, refused, and refused again on replay, so all of that is checked
      // here over the real protocol and not only in the unit suite.
      const nonce = parsed.nonce
      record('response carries a nonce', typeof nonce === 'string' && nonce.length > 0)
      record('nonce looks like base64url', /^[A-Za-z0-9_-]{22}$/.test(String(nonce)))

      if (typeof nonce === 'string' && nonce.length > 0) {
        const honest = await deadline(
          send('tools/call', {
            name: 'verify_decision',
            arguments: { nonce, decision: parsed.decision },
          }),
          10_000,
          'verify_decision (honest)',
        )
        const honestBody = JSON.parse(String(honest.result?.content?.[0]?.text ?? '{}'))
        record('verify_decision accepts the real decision', honestBody.valid === true)

        const replay = await deadline(
          send('tools/call', {
            name: 'verify_decision',
            arguments: { nonce, decision: parsed.decision },
          }),
          10_000,
          'verify_decision (replay)',
        )
        const replayBody = JSON.parse(String(replay.result?.content?.[0]?.text ?? '{}'))
        record('verify_decision refuses a replayed nonce', replayBody.valid === false)

        // A second, fresh nonce, spent with the wrong decision. This is the Phase 4
        // failure: a model reporting "allow" for a server that said "deny".
        const second = await deadline(
          send('tools/call', {
            name: 'pre_action_check',
            arguments: { taskDescription: 'test', proposedChange: 'noop', affectedFiles: [] },
          }),
          10_000,
          'pre_action_check (second)',
        )
        const secondNonce = JSON.parse(String(second.result?.content?.[0]?.text ?? '{}')).nonce
        const wrong = await deadline(
          send('tools/call', {
            name: 'verify_decision',
            arguments: { nonce: secondNonce, decision: 'allow' },
          }),
          10_000,
          'verify_decision (mismatch)',
        )
        const wrongBody = JSON.parse(String(wrong.result?.content?.[0]?.text ?? '{}'))
        record('verify_decision catches a mismatched decision', wrongBody.valid === false)
        record(
          'verify_decision reports the decision actually issued',
          wrongBody.originalDecision === 'deny',
          `originalDecision=${wrongBody.originalDecision}`,
        )
      }
    }
  }
  record('stdout carried only JSON-RPC frames', stdoutWasPureJson, `${frames} frame(s)`)
  record('server logged to stderr', serverStderr.length > 0, `${serverStderr.length} bytes`)
} catch (error) {
  record('protocol exchange completed', false, error.message)
} finally {
  // MCP has no shutdown request over stdio; closing the transport ends the session.
  try {
    child.stdin.end()
  } catch {
    // The child may already be gone.
  }
  child.kill('SIGKILL')
}
const passed = checks.every((check) => check.ok)
process.stdout.write(`${JSON.stringify({ protocolVersion: PROTOCOL, passed, checks }, null, 2)}\n`)
process.exit(passed ? 0 : 1)
