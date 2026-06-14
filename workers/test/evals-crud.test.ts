import { describe, it, expect } from 'vitest'
import { deleteEvalScenario, updateEvalScenario, reviewEvalScenario } from '../src/lib/evals-crud'
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

// A richer fake that supports first()/run() so we can exercise update/review.
// `row` is what SELECT ... first() returns; `changes` is what UPDATE.run()
// reports via meta (0 = no row matched the tenant scope).
class FakeQueryDb {
  writes: { sql: string; binds: unknown[] }[] = []
  constructor(public row: Record<string, unknown> | null, public changes = 1) {}
  prepare(sql: string) {
    const self = this
    let binds: unknown[] = []
    return {
      bind(...args: unknown[]) { binds = args; return this },
      async first() { return self.row },
      async run() { self.writes.push({ sql, binds }); return { success: true, meta: { changes: self.changes } } },
    }
  }
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

describe('updateEvalScenario', () => {
  const existing = { id: 's1', description: 'old', expected_behavior: 'old eb', test_message: 'old msg' }

  it('404s when the scenario does not exist for this tenant', async () => {
    const db = new FakeQueryDb(null)
    const res = await updateEvalScenario({ DB: db } as unknown as Env, 't1', 's1', { description: 'x' })
    expect(res).toEqual({ error: 'Scenario not found', status: 404 })
  })

  it('updates provided fields, keeps the rest, and RESETS the verdict to unreviewed', async () => {
    const db = new FakeQueryDb(existing)
    const res = await updateEvalScenario({ DB: db } as unknown as Env, 't1', 's1', { description: 'new desc' })
    expect(res).toEqual({ id: 's1', description: 'new desc', expected_behavior: 'old eb', test_message: 'old msg' })
    const w = db.writes.find(x => /UPDATE eval_scenarios/.test(x.sql))!
    // editing a scenario invalidates the old human verdict
    expect(w.sql).toMatch(/review_status = 'unreviewed'/)
    expect(w.sql).toMatch(/reviewed_at = NULL/)
    expect(w.binds).toEqual(['new desc', 'old eb', 'old msg', 's1', 't1'])
  })

  it('rejects blanking a field', async () => {
    const db = new FakeQueryDb(existing)
    const res = await updateEvalScenario({ DB: db } as unknown as Env, 't1', 's1', { test_message: '   ' })
    expect(res).toEqual({ error: 'description, expected_behavior, and test_message cannot be blank', status: 400 })
  })
})

describe('reviewEvalScenario', () => {
  it('rejects an invalid status', async () => {
    const db = new FakeQueryDb({ id: 's1' })
    const res = await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 's1', 'bogus')
    expect('error' in res && res.status).toBe(400)
  })

  it('approve stamps reviewed_at; unreviewed clears it', async () => {
    const db = new FakeQueryDb({ id: 's1' })
    const approved = await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 's1', 'approved')
    expect(approved).toMatchObject({ id: 's1', review_status: 'approved' })
    expect((approved as { reviewed_at: string | null }).reviewed_at).toBeTruthy()

    const cleared = await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 's1', 'unreviewed')
    expect(cleared).toMatchObject({ review_status: 'unreviewed', reviewed_at: null })
  })

  it('404s when no row matched the tenant scope (changes = 0)', async () => {
    const db = new FakeQueryDb({ id: 's1' }, 0)
    const res = await reviewEvalScenario({ DB: db } as unknown as Env, 't1', 'nope', 'rejected')
    expect(res).toEqual({ error: 'Scenario not found', status: 404 })
  })
})
