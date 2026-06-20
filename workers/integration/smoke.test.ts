import { describe, it, expect } from 'vitest'
import { BASE_URL, adminHeaders } from './_harness'

describe('integration smoke', () => {
  it('health endpoint is green', async () => {
    const res = await fetch(`${BASE_URL}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // Response shape: { status, database, vectorize, storage, media_storage, ai }
    // Defined in workers/src/types/health.ts — the key is 'database', not 'db'.
    expect(body).toHaveProperty('database')
    expect(body.status).toBe('healthy')
  })

  it('admin auth works with a minted token', async () => {
    const res = await fetch(`${BASE_URL}/admin/bot-status`, { headers: adminHeaders })
    expect(res.status).toBe(200)
  })
})
