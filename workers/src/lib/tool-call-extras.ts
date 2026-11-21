/**
 * Preserves provider-specific `extra_content` on OpenAI-format tool calls
 * across the steps of one copilot turn.
 *
 * Gemini (3+/4) attaches a thought signature to every function call
 * (`tool_calls[].extra_content.google.thought_signature`) and rejects the next
 * request in a multi-step tool loop if the signature isn't echoed back.
 * `@ai-sdk/openai` parses tool calls into its own shape and drops unknown
 * fields, so without this the copilot's second tool step would 400 on Gemini.
 *
 * The returned fetch remembers `extra_content` by tool-call id from each
 * response (JSON or SSE) and re-attaches it to the matching assistant
 * `tool_calls` entries in later requests. Build one per agent turn — the map
 * lives only as long as the closure. Bodies pass through untouched otherwise.
 */
export function createToolCallExtrasFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const extras = new Map<string, unknown>()

  const remember = (toolCalls: unknown, indexToId?: Map<number, string>) => {
    if (!Array.isArray(toolCalls)) return
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue
      const call = tc as { id?: unknown; index?: unknown; extra_content?: unknown }
      let id = typeof call.id === 'string' && call.id ? call.id : undefined
      if (indexToId && typeof call.index === 'number') {
        if (id) indexToId.set(call.index, id)
        else id = indexToId.get(call.index)
      }
      if (id && call.extra_content !== undefined) extras.set(id, call.extra_content)
    }
  }

  const injectExtras = (init: RequestInit | undefined): RequestInit | undefined => {
    if (!extras.size || typeof init?.body !== 'string') return init
    let body: { messages?: unknown }
    try { body = JSON.parse(init.body) } catch { return init }
    if (!Array.isArray(body.messages)) return init
    let changed = false
    for (const m of body.messages) {
      if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
      for (const tc of m.tool_calls) {
        const extra = typeof tc?.id === 'string' ? extras.get(tc.id) : undefined
        if (extra !== undefined && tc.extra_content === undefined) {
          tc.extra_content = extra
          changed = true
        }
      }
    }
    return changed ? { ...init, body: JSON.stringify(body) } : init
  }

  return async (input, init) => {
    const response = await baseFetch(input, injectExtras(init))
    if (!response.ok || !response.body) return response
    const contentType = response.headers.get('content-type') ?? ''

    if (contentType.includes('application/json')) {
      try {
        const json = await response.clone().json() as { choices?: Array<{ message?: { tool_calls?: unknown } }> }
        remember(json.choices?.[0]?.message?.tool_calls)
      } catch { /* not a chat completion — pass through */ }
      return response
    }

    if (!contentType.includes('text/event-stream')) return response

    // Observe the SSE stream without altering it.
    const decoder = new TextDecoder()
    const indexToId = new Map<number, string>()
    let buffer = ''
    const observe = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') return
      try {
        const ev = JSON.parse(data) as { choices?: Array<{ delta?: { tool_calls?: unknown } }> }
        remember(ev.choices?.[0]?.delta?.tool_calls, indexToId)
      } catch { /* keepalive / partial — ignore */ }
    }
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        buffer += decoder.decode(chunk, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) !== -1) {
          observe(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
        }
      },
      flush() {
        if (buffer) observe(buffer)
      },
    }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
