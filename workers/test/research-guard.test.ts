import { describe, expect, it, vi } from 'vitest'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
  createResearchWriteGuard,
  guardResearchWrites,
  RESEARCH_SAFE_TOOLS,
} from '../src/lib/tools/research-guard'

const options = { toolCallId: 'call-1', messages: [], context: {} }

function toolSet(executes: Record<string, () => unknown>): ToolSet {
  const set: ToolSet = {}
  for (const [name, execute] of Object.entries(executes)) {
    set[name] = tool({ description: name, inputSchema: z.object({}), execute })
  }
  return set
}

describe('research write guard', () => {
  it('starts clean and offers every tool', () => {
    const guard = createResearchWriteGuard()
    const tools = toolSet({ save_protocols: () => 'wrote', get_config: () => 'read' })
    expect(guard.researchConsumed).toBe(false)
    expect(guard.activeToolNames(tools).sort()).toEqual(['get_config', 'save_protocols'])
  })

  it('withholds write tools from the model once research is consumed', () => {
    const guard = createResearchWriteGuard()
    const tools = toolSet({
      save_protocols: () => 'wrote',
      manage_referrals: () => 'wrote',
      update_species_config: () => 'wrote',
      get_config: () => 'read',
      web_search: () => 'searched',
    })
    guard.markResearchConsumed()
    expect(guard.researchConsumed).toBe(true)
    expect(guard.activeToolNames(tools).sort()).toEqual(['get_config', 'web_search'])
  })

  it('refuses a write that the dispatcher still routes in the research step', async () => {
    const guard = createResearchWriteGuard()
    const save = vi.fn(() => 'wrote')
    const guarded = guardResearchWrites(toolSet({ save_protocols: save }), guard)

    expect(await guarded.save_protocols!.execute!({}, options)).toBe('wrote')

    guard.markResearchConsumed()
    const blocked = await guarded.save_protocols!.execute!({}, options)
    expect(blocked).toMatchObject({ success: false, requires_operator_confirmation: true })
    expect((blocked as { error: string }).error).toMatch(/Blocked for safety/)
    // The underlying tool never ran a second time.
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('leaves read-only and research tools callable after research', async () => {
    const guard = createResearchWriteGuard()
    const guarded = guardResearchWrites(toolSet({
      get_config: () => 'read',
      search_knowledge_base: () => 'read',
      fetch_url: () => 'read',
      web_fetch: () => 'fetched',
    }), guard)
    guard.markResearchConsumed()
    for (const name of ['get_config', 'search_knowledge_base', 'fetch_url', 'web_fetch']) {
      expect(await guarded[name]!.execute!({}, options)).not.toMatchObject({ requires_operator_confirmation: true })
    }
  })

  it('treats an unclassified tool as a write tool (fail closed)', async () => {
    const guard = createResearchWriteGuard()
    const guarded = guardResearchWrites(toolSet({ some_future_tool: () => 'wrote' }), guard)
    guard.markResearchConsumed()
    expect(RESEARCH_SAFE_TOOLS.has('some_future_tool')).toBe(false)
    expect(await guarded.some_future_tool!.execute!({}, options))
      .toMatchObject({ success: false, requires_operator_confirmation: true })
    expect(guard.activeToolNames(guarded)).toEqual([])
  })

  it('preserves tool metadata so the model still sees descriptions and schemas', () => {
    const guard = createResearchWriteGuard()
    const tools = toolSet({ save_protocols: () => 'wrote' })
    const guarded = guardResearchWrites(tools, guard)
    expect(guarded.save_protocols!.description).toBe(tools.save_protocols!.description)
    expect(guarded.save_protocols!.inputSchema).toBe(tools.save_protocols!.inputSchema)
  })
})
