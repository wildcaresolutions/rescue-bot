/**
 * Line-delimited streaming protocol for the copilot agent.
 *
 * Extracted from workers/src/routes/agent.ts. The /admin/agent endpoint
 * uses a simple line-per-event encoding (NOT SSE) so the browser-side
 * client can `for await` over a fetch response and split on '\n':
 *
 *   0:"text"        text delta
 *   9:{...}         tool-input-start (toolCallId, toolName)
 *   a:{...}         tool-input-delta (toolCallId, argsTextDelta)
 *   b:{...}         tool-result (toolCallId, toolName, result)
 *   e:{...}         finish (finishReason)
 *
 * Documented at the API level in CLAUDE.md → "Copilot Streaming Protocol".
 */

/**
 * Shape we consume from `streamText().fullStream`. Kept loose — the
 * stream parts are discriminated by `type` and we only read the fields
 * the protocol cares about.
 */
type FullStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'finish'; finishReason: string }
  // The AI SDK emits other part types we ignore.
  | { type: string }

export function buildAgentStream(fullStream: AsyncIterable<FullStreamPart>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const part of fullStream) {
          let line: string | null = null
          if (part.type === 'text-delta') {
            line = `0:${JSON.stringify((part as { text: string }).text)}`
          } else if (part.type === 'tool-input-start') {
            const p = part as { id: string; toolName: string }
            line = `9:${JSON.stringify({ toolCallId: p.id, toolName: p.toolName })}`
          } else if (part.type === 'tool-input-delta') {
            const p = part as { id: string; delta: string }
            line = `a:${JSON.stringify({ toolCallId: p.id, argsTextDelta: p.delta })}`
          } else if (part.type === 'tool-result') {
            const p = part as { toolCallId: string; toolName: string; output: unknown }
            line = `b:${JSON.stringify({ toolCallId: p.toolCallId, toolName: p.toolName, result: p.output })}`
          } else if (part.type === 'finish') {
            line = `e:${JSON.stringify({ finishReason: (part as { finishReason: string }).finishReason })}`
          }
          if (line) {
            controller.enqueue(encoder.encode(line + '\n'))
          }
        }
      } catch (e) {
        console.error('[agent] stream error:', e)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
