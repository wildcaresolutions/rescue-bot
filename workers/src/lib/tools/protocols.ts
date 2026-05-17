/**
 * Protocols + test-scenario tools.
 *
 * - save_protocols: writes raw custom_instruction text (clamped to 10k).
 * - create_test_scenario, list_test_scenarios: CRUD on eval_scenarios.
 * - run_test_scenario: invokes the eval pipeline from routes/admin.ts
 *   and returns the actual pass/fail so the agent can react in the same
 *   turn (otherwise the agent would tell the user to "run and report
 *   back").
 *
 * Extracted from workers/src/routes/agent.ts.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './types'
import { formatTestResultExplanation } from '../judge-parse'
import { runEvalScenario } from '../eval-runner'

export function protocolsTools(ctx: ToolContext) {
  const { env, db, tenantId, freshTenant, invalidateCache } = ctx

  const save_protocols = tool({
    description: 'Saves custom rescue instructions/protocols for the organization',
    inputSchema: z.object({
      custom_instruction: z.string().describe('The full custom instruction text for the rescue bot'),
    }),
    execute: async (input) => {
      await db.prepare(
        "UPDATE tenants SET custom_instruction = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(input.custom_instruction.slice(0, 10_000), tenantId).run()
      invalidateCache()
      return { success: true, message: 'Protocols saved' }
    },
  })

  const create_test_scenario = tool({
    description: 'Creates a test case to verify how the rescue bot handles a specific situation',
    inputSchema: z.object({
      description: z.string().describe('Plain English description of the scenario'),
      expected_behavior: z.string().describe('What the bot should do'),
      test_message: z.string().describe('The actual message a user would type to the bot'),
    }),
    execute: async (input) => {
      const id = crypto.randomUUID()
      await db.prepare(
        `INSERT INTO eval_scenarios (id, tenant_id, description, expected_behavior, test_message, auto_generated)
         VALUES (?, ?, ?, ?, ?, 1)`,
      ).bind(id, tenantId, input.description, input.expected_behavior, input.test_message).run()
      // Spread input fields top-level so the frontend's breadcrumb chip can
      // render "Added test case: <description> · "<test_message>"" without
      // having to dig into result.scenario.* or parse the message string.
      return {
        success: true,
        id,
        description: input.description,
        test_message: input.test_message,
        expected_behavior: input.expected_behavior,
        message: `Test case created: "${input.description}"`,
      }
    },
  })

  const list_test_scenarios = tool({
    description: 'Lists all test cases for this organization',
    inputSchema: z.object({}),
    execute: async () => {
      const { results } = await db.prepare(
        'SELECT id, description, expected_behavior, test_message, created_at FROM eval_scenarios WHERE tenant_id = ? ORDER BY created_at DESC',
      ).bind(tenantId).all()
      return { scenarios: results, count: results.length }
    },
  })

  const run_test_scenario = tool({
    description: 'Run a test case by ID and return the actual pass/fail result. Waits for the bot response and scoring step so the agent can react to the outcome on the same turn.',
    inputSchema: z.object({ scenario_id: z.string() }),
    execute: async ({ scenario_id }) => {
      try {
        const scenario = await db.prepare(
          'SELECT id, description, expected_behavior, test_message FROM eval_scenarios WHERE id = ? AND tenant_id = ?',
        ).bind(scenario_id, tenantId).first<{ id: string; description: string; expected_behavior: string; test_message: string }>()
        if (!scenario) return { success: false, error: 'Scenario not found' }
        await runEvalScenario(env, freshTenant, scenario)
        const latest = await db.prepare(
          'SELECT response, passed, judge_reasoning, created_at FROM eval_results WHERE scenario_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 1',
        ).bind(scenario_id, tenantId).first<{ response: string; passed: number | null; judge_reasoning: string }>()
        if (!latest) return { success: false, error: 'Test case completed but no result was stored' }
        return {
          success: true,
          scenario_id,
          description: scenario.description,
          passed: latest.passed === null ? null : latest.passed === 1,
          scoring_status: latest.passed === null ? 'not_scored' : latest.passed === 1 ? 'pass' : 'fail',
          result_explanation: formatTestResultExplanation(latest.judge_reasoning),
          response_excerpt: (latest.response || '').slice(0, 600),
        }
      } catch (e) {
        console.error('[run_test_scenario] error:', e)
        return { success: false, error: 'Failed to run test case: ' + (e instanceof Error ? e.message : String(e)) }
      }
    },
  })

  return {
    save_protocols,
    create_test_scenario,
    list_test_scenarios,
    run_test_scenario,
  }
}
