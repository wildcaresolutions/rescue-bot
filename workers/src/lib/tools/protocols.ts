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
import { stageConfigChange, overlayTenant } from '../draft'
import { updateEvalScenario, reviewEvalScenario, deleteEvalScenario } from '../evals-crud'

export function protocolsTools(ctx: ToolContext) {
  const { env, db, tenantId, freshTenant } = ctx
  const target = { id: tenantId, slug: freshTenant.slug }

  const save_protocols = tool({
    description: 'Saves custom rescue instructions/protocols for the organization. Staged as a draft until the operator publishes (a raw-prompt edit wins over auto-compile at publish).',
    inputSchema: z.object({
      custom_instruction: z.string().describe('The full custom instruction text for the rescue bot'),
    }),
    execute: async (input) => {
      await stageConfigChange(db, target, { custom_instruction: input.custom_instruction.slice(0, 10_000) })
      return { success: true, message: 'Protocols saved (staged)' }
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
    description: 'Lists all test cases for this organization, including the operator\'s review verdict (review_status: approved/rejected/unreviewed — the authoritative human judgment).',
    inputSchema: z.object({}),
    execute: async () => {
      const { results } = await db.prepare(
        'SELECT id, description, expected_behavior, test_message, review_status, reviewed_at, created_at FROM eval_scenarios WHERE tenant_id = ? ORDER BY created_at DESC',
      ).bind(tenantId).all()
      return { scenarios: results, count: results.length }
    },
  })

  const update_test_scenario = tool({
    description: 'Edit an existing test case\'s wording (description, expected behavior, or the visitor message). Use this when a test is worded badly instead of telling the operator to delete and recreate it. Editing resets its review verdict to unreviewed.',
    inputSchema: z.object({
      scenario_id: z.string(),
      description: z.string().optional(),
      expected_behavior: z.string().optional(),
      test_message: z.string().optional(),
    }),
    execute: async ({ scenario_id, ...fields }) => {
      const res = await updateEvalScenario(env, tenantId, scenario_id, fields)
      if ('error' in res) return { success: false, error: res.error }
      return { success: true, ...res, message: `Test case updated: "${res.description}"` }
    },
  })

  const delete_test_scenario = tool({
    description: 'Delete a test case. The operator is always allowed to remove a test — NEVER tell them to email support to delete one. Handles cleanup of any past results.',
    inputSchema: z.object({ scenario_id: z.string() }),
    execute: async ({ scenario_id }) => {
      try {
        await deleteEvalScenario(env, tenantId, scenario_id)
        return { success: true, scenario_id, message: 'Test case deleted.' }
      } catch (e) {
        console.error('[delete_test_scenario] error:', e)
        return { success: false, error: 'Failed to delete test case.' }
      }
    },
  })

  const mark_test_reviewed = tool({
    description: 'Record the operator\'s OWN verdict on a test case — this is the authoritative judgment, overriding the auto-grader. Use "approved" when the operator is happy with the bot\'s answer (👍), "rejected" when they are not (👎), or "unreviewed" to clear it.',
    inputSchema: z.object({
      scenario_id: z.string(),
      review_status: z.enum(['approved', 'rejected', 'unreviewed']),
    }),
    execute: async ({ scenario_id, review_status }) => {
      const res = await reviewEvalScenario(env, tenantId, scenario_id, review_status)
      if ('error' in res) return { success: false, error: res.error }
      return { success: true, ...res, message: `Marked test case as ${review_status}.` }
    },
  })

  const run_test_scenario = tool({
    description: 'Run a test case by ID and return the auto-grader\'s ADVISORY hint. The auto-grade (passed/scoring_status) is only a suggestion — the operator\'s 👍/👎 verdict is what counts and it NEVER blocks publishing. If the operator disagrees with the auto-grade, take their side and offer to mark_test_reviewed or update_test_scenario. Never treat a fail/not_scored as a blocker.',
    inputSchema: z.object({ scenario_id: z.string() }),
    execute: async ({ scenario_id }) => {
      try {
        const scenario = await db.prepare(
          'SELECT id, description, expected_behavior, test_message FROM eval_scenarios WHERE id = ? AND tenant_id = ?',
        ).bind(scenario_id, tenantId).first<{ id: string; description: string; expected_behavior: string; test_message: string }>()
        if (!scenario) return { success: false, error: 'Scenario not found' }
        // Run against the draft overlay so the operator tests pending changes.
        await runEvalScenario(env, overlayTenant(freshTenant), scenario)
        const latest = await db.prepare(
          'SELECT response, passed, judge_reasoning, created_at FROM eval_results WHERE scenario_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 1',
        ).bind(scenario_id, tenantId).first<{ response: string; passed: number | null; judge_reasoning: string }>()
        if (!latest) return { success: false, error: 'Test case completed but no result was stored' }
        return {
          success: true,
          scenario_id,
          description: scenario.description,
          // ADVISORY only — the human verdict (mark_test_reviewed) is authoritative.
          advisory_passed: latest.passed === null ? null : latest.passed === 1,
          scoring_status: latest.passed === null ? 'not_scored' : latest.passed === 1 ? 'pass' : 'fail',
          advisory_note: 'This is the auto-grader\'s hint, not a verdict. The operator decides with 👍/👎; it never blocks publishing.',
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
    update_test_scenario,
    delete_test_scenario,
    mark_test_reviewed,
    run_test_scenario,
  }
}
