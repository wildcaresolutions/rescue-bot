import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')

describe('photo eval harness', () => {
  // Audit ralph-2 M6: previous test asserted strings against .gitignore
  // — that's checking documentation, not behavior. If the .gitignore is
  // restructured to use globs (e.g. evals/photo/**) the test fails while
  // the actual ignore behavior is unchanged. Replaced with a behavioral
  // check via `git check-ignore`, which exits 0 only when the path is
  // actually ignored.
  it('git-check-ignore reports the fixture/label paths as ignored', () => {
    for (const p of [
      'evals/photo/fixtures/test.jpg',
      'evals/photo/inbox/test.jpg',
      'evals/photo/labels.jsonl',
      'evals/photo/reports/run.json',
    ]) {
      // `git check-ignore -q` exits 0 if the file IS ignored, 1 if not.
      // execFileSync throws on non-zero, so success = ignored.
      try {
        execFileSync('git', ['check-ignore', '-q', p], { cwd: root })
      } catch {
        throw new Error(`expected ${p} to be git-ignored`)
      }
    }
  })

  it('validates the committed example labels in dry-run mode', () => {
    const output = execFileSync('node', [
      join(root, 'evals/photo/run-photo-eval.mjs'),
      '--dry-run',
      '--allow-missing-fixtures',
      '--labels',
      join(root, 'evals/photo/labels.example.jsonl'),
    ], {
      cwd: root,
      encoding: 'utf8',
    })
    const report = JSON.parse(output)
    expect(report.ok).toBe(true)
    expect(report.mode).toBe('dry-run')
    expect(report.count).toBeGreaterThan(0)
    expect(report.validation_errors).toEqual([])
  })

  it('ingests emailed image attachments as ignored TODO label rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-ingest-'))
    const inbox = join(dir, 'inbox')
    const fixtures = join(dir, 'fixtures')
    const labels = join(dir, 'labels.jsonl')
    execFileSync('mkdir', ['-p', inbox])
    writeFileSync(join(inbox, 'Young bird from email.JPG'), Buffer.from([1, 2, 3, 4]))
    writeFileSync(join(inbox, 'notes.txt'), 'not an image')

    const output = execFileSync('node', [
      join(root, 'evals/photo/ingest-photos.mjs'),
      '--src',
      inbox,
      '--fixtures',
      fixtures,
      '--labels',
      labels,
      '--source',
      'unit-test-email',
    ], {
      cwd: root,
      encoding: 'utf8',
    })
    const report = JSON.parse(output)
    expect(report.imported).toHaveLength(1)
    expect(report.imported[0].to).toMatch(/fixtures\/\d{4}-\d{2}-\d{2}-young-bird-from-email-[a-f0-9]{12}\.jpg$/i)

    const row = JSON.parse(readFileSync(labels, 'utf8').trim())
    expect(row.label_status).toBe('needs_label')
    expect(row.expected).toEqual({})
    expect(row.source).toBe('unit-test-email')
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
