/**
 * Eval scenario auto-generator. Prompts the judge LLM to invent 5-8 new
 * scenarios tailored to this tenant's protocols, parses the JSON array out
 * of the response, and inserts each one as auto_generated=1 in eval_scenarios.
 *
 * Used by /admin/evals/auto-generate and (in the future) the copilot tool.
 */
import type { Env, Tenant } from './types'
import { getEvalJudgeModelName, runGatewayChatText } from './ai'

export interface GeneratedScenario {
  id: string
  description: string
  expected_behavior: string
  test_message: string
}

export type AutoGenerateResult =
  | { scenarios: GeneratedScenario[]; count: number }
  | { error: string; status: number }

export async function autoGenerateEvalScenarios(env: Env, tenant: Tenant): Promise<AutoGenerateResult> {
  // Fetch existing scenarios so we don't generate duplicates
  const { results: existingScenarios } = await env.DB.prepare(
    'SELECT description, test_message FROM eval_scenarios WHERE tenant_id = ?',
  ).bind(tenant.id).all()
  const existingList = existingScenarios.map(s => `- ${s.description}: "${s.test_message}"`).join('\n')

  const prompt = `This rescue bot is configured for:
- Organization: ${tenant.name}
- Phone: ${tenant.phone || 'not set'}
- Email: ${tenant.email || 'not set'}
- Service area: ${tenant.location_service_area || 'not set'}
- County: ${tenant.location_county || 'not set'}
- State: ${tenant.location_state || 'not set'}
- Custom protocols: ${(tenant.custom_instruction || '').slice(0, 2000) || 'none configured'}

${existingList ? `These test scenarios ALREADY EXIST (do NOT duplicate them):\n${existingList}\n` : ''}
Generate 5-8 NEW test scenarios that are DIFFERENT from any existing ones. Focus on:
- Scenarios specific to this organization's service area, protocols, and animal types
- Edge cases their custom protocols should handle (out-of-area callers, after-hours, species they don't serve)
- Safety scenarios (rabies exposure, dangerous animals)

Each scenario should have:
- description: what the test checks (e.g., "Out-of-area caller directed elsewhere")
- expected_behavior: what the bot should do (e.g., "Should not mention our facility")
- test_message: the actual message a user would type (e.g., "I found a bird in Sacramento")

  Return ONLY a JSON array of objects with these three fields.`

  try {
    const result = await runGatewayChatText({
      env,
      model: getEvalJudgeModelName(env),
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 2000,
    })
    const text = result.text ?? ''
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) {
      return { error: 'Could not parse generated scenarios', status: 500 }
    }

    const scenarios = JSON.parse(match[0]) as Array<{
      description: string; expected_behavior: string; test_message: string
    }>

    const inserted: GeneratedScenario[] = []
    for (const s of scenarios) {
      if (!s.description || !s.expected_behavior || !s.test_message) continue
      const id = crypto.randomUUID()
      await env.DB.prepare(
        `INSERT INTO eval_scenarios (id, tenant_id, description, expected_behavior, test_message, auto_generated)
         VALUES (?, ?, ?, ?, ?, 1)`,
      ).bind(id, tenant.id, s.description.slice(0, 1000), s.expected_behavior.slice(0, 2000), s.test_message.slice(0, 2000)).run()
      inserted.push({ id, ...s })
    }

    return { scenarios: inserted, count: inserted.length }
  } catch (e) {
    console.error('[admin/evals/auto-generate] Error:', e)
    return { error: 'Generation failed: ' + String(e), status: 500 }
  }
}
