/**
 * Structural prompt-injection containment for the admin copilot.
 *
 * `web_search` / `web_fetch` put attacker-controlled text into the model's
 * context. Prompt wording alone does not stop that text from talking the
 * copilot into calling save_protocols, manage_referrals, update_species_config
 * or any other state-changing tool. So the route enforces it mechanically:
 *
 *   once a turn calls a research tool, every state-changing tool is withheld
 *   for the rest of that turn.
 *
 * The copilot has to report what it found and ask the operator; the operator's
 * reply starts a fresh turn that carries no fetched page text (agent history
 * persists user/assistant prose only, never tool results — see
 * lib/agent-history.ts), so the edit happens on operator instruction rather
 * than on instructions smuggled in through a web page.
 *
 * Two independent layers, both driven by the same per-request flag:
 *
 *   1. `activeToolNames()` feeds streamText's `prepareStep`, so after the
 *      research step the write tools are not even offered to the model.
 *   2. `guardResearchWrites()` wraps every tool's `execute`, which also covers
 *      a model that asks for research and a write in the SAME step (layer 1
 *      cannot, the step's tool set is already fixed).
 *
 * The read-only list is an ALLOWLIST: a tool added later is treated as a write
 * tool until someone deliberately classifies it, so the failure mode of
 * forgetting to update this file is "too strict", never "silently writable".
 */
import type { ToolSet } from 'ai'
import { WEB_RESEARCH_TOOL_NAMES } from './web-search'

/**
 * Copilot tools that cannot change tenant state, plus the research tools
 * themselves (the copilot must stay able to keep reading after step one).
 * Everything else counts as a write tool.
 */
export const RESEARCH_SAFE_TOOLS: ReadonlySet<string> = new Set([
  ...WEB_RESEARCH_TOOL_NAMES,
  // Reads
  'get_config',
  'get_recent_sessions',
  'get_setup_readiness',
  'get_species_config',
  'get_stats',
  'list_documents',
  'list_test_scenarios',
  'run_analytics_query',
  'search_knowledge_base',
  // Outbound reads — already constrained by lib/safe-url.ts
  'extract_brand_colors',
  'fetch_url',
  'harvest_website_info',
  // Client-side navigation only; writes nothing
  'navigate_to_tab',
  // Read-only derivation of the already-published embed snippet
  'get_embed_code',
])

/** Structurally erased tool signature — the guard never inspects arguments. */
type ToolExecute = (args: unknown, options: unknown) => unknown

const BLOCKED_ERROR =
  'Blocked for safety: this turn already pulled in public web content, so settings-changing tools are disabled until the operator confirms. ' +
  'Summarize what you found, cite the source URLs, state the exact change you want to make, and ask the operator to confirm. ' +
  'Make the change after they reply.'

export interface ResearchWriteGuard {
  /** Mark this turn as research-influenced. Called by the research tools. */
  markResearchConsumed(): void
  /** True once a research tool ran in this turn. */
  readonly researchConsumed: boolean
  /**
   * Tool names the model may use for the next step: everything while clean,
   * the read-only allowlist once research has been consumed.
   */
  activeToolNames<T extends ToolSet>(tools: T): Array<keyof T & string>
}

export function createResearchWriteGuard(): ResearchWriteGuard {
  let consumed = false
  return {
    markResearchConsumed() { consumed = true },
    get researchConsumed() { return consumed },
    activeToolNames<T extends ToolSet>(tools: T) {
      const names = Object.keys(tools) as Array<keyof T & string>
      return consumed ? names.filter(name => RESEARCH_SAFE_TOOLS.has(name)) : names
    },
  }
}

/**
 * Wrap a tool set so state-changing tools refuse to run once the guard is
 * tripped. Returns a refusal to the model instead of throwing, so the copilot
 * can explain itself and ask the operator rather than erroring out mid-stream.
 */
export function guardResearchWrites<T extends ToolSet>(tools: T, guard: ResearchWriteGuard): T {
  const guarded: Record<string, ToolSet[string]> = {}
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute as ToolExecute | undefined
    if (!execute || RESEARCH_SAFE_TOOLS.has(name)) {
      guarded[name] = definition
      continue
    }
    const blocking: ToolExecute = (args, options) => {
      if (guard.researchConsumed) {
        return { success: false, error: BLOCKED_ERROR, requires_operator_confirmation: true }
      }
      return execute(args, options)
    }
    guarded[name] = { ...definition, execute: blocking as ToolSet[string]['execute'] }
  }
  return guarded as T
}
