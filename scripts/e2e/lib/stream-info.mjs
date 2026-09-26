/**
 * Reads a fact out of an OpenCode --format json stream.
 *
 * Reads newline-delimited JSON frames on stdin and prints one of:
 *   model   the model identifier, if the stream carries one
 *   keys    the top-level keys of the first frame, for diffing across runs
 *   error   a compact description of the first error frame, if any
 *
 * The model query is speculative on purpose. OpenCode v2.0.18 does not put a
 * model field in this stream, verified across runs including an explicit
 * --model, so today it prints nothing. It is kept because it costs three lines
 * and would light up by itself if a future version starts reporting one.
 *
 * Usage: node stream-info.mjs <model|keys|error>
 */

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  const frames = []
  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      frames.push(JSON.parse(trimmed))
    } catch {
      // Non-JSON on stdout would be a protocol violation; ignore it here.
    }
  }

  const first = frames[0] ?? {}
  const query = process.argv[2] ?? 'keys'

  if (query === 'keys') {
    process.stdout.write(Object.keys(first).join(','))
    return
  }

  if (query === 'model') {
    // Field names tried, in order of likelihood across OpenCode versions.
    for (const key of ['modelID', 'modelId', 'model', 'providerID']) {
      const value = first[key] ?? first.part?.[key]
      if (typeof value === 'string' && value !== '') {
        process.stdout.write(value)
        return
      }
    }
    return
  }

  if (query === 'error') {
    const frame = frames.find((candidate) => candidate.error !== undefined)
    if (frame === undefined) return
    const { type, message, status } = frame.error ?? {}
    const bits = [type, status].filter((part) => part !== undefined && part !== null)
    const head = bits.length > 0 ? bits.join('/') : 'error'
    // The message is trimmed because a provider error body can be a page long.
    const text = typeof message === 'string' ? message.slice(0, 80) : ''
    process.stdout.write(text === '' ? head : `${head} ${text}`)
  }
})
