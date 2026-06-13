import { describe, it, expect } from 'vitest'
import { deleteEvalScenario } from '../src/lib/evals-crud'
import type { Env } from '../src/lib/types'

// Minimal D1 fake that records prepared SQL + the statements passed to batch().
class FakeStmt {
  binds: unknown[] = []
  constructor(public sql: string) {}
  bind(...args: unknown[]) { this.binds = args; return this }
}
class FakeD1 {
  batched: FakeStmt[][] = []
  prepare(sql: string) { return new FakeStmt(sql) }
  async batch(stmts: FakeStmt[]) { this.batched.push(stmts); return stmts.map(() => ({ success: true })) }
}

describe('deleteEvalScenario', () => {
  it('deletes results before the scenario in one atomic batch', async () => {
    // eval_results FKs eval_scenarios(id) with no ON DELETE CASCADE, so a
    // scenario that has been run can't be deleted scenario-first — that was
    // the "can't delete the test case" bug. Order + atomicity matter.
    const db = new FakeD1()
    await deleteEvalScenario({ DB: db } as unknown as Env, 'tenant-1', 'scenario-9')

    expect(db.batched).toHaveLength(1)
    const [results, scenario] = db.batched[0]
    expect(results.sql).toContain('DELETE FROM eval_results')
    expect(scenario.sql).toContain('DELETE FROM eval_scenarios')
    // Both scoped to the tenant + scenario id.
    expect(results.binds).toEqual(['scenario-9', 'tenant-1'])
    expect(scenario.binds).toEqual(['scenario-9', 'tenant-1'])
  })
})
