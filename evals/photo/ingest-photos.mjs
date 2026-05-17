#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')

const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
])

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error
  out(`Photo corpus ingest

Usage:
  node evals/photo/ingest-photos.mjs --src ~/Downloads/wildcare-photos
  make eval-photo-ingest PHOTO_SRC=~/Downloads/wildcare-photos

Options:
  --src <path>          File or directory of downloaded email attachments.
                        Defaults to evals/photo/inbox.
  --fixtures <dir>     Corpus fixture dir. Default: evals/photo/fixtures.
  --labels <path>      Labels JSONL path. Default: evals/photo/labels.jsonl.
  --source <text>      Source note for label rows. Default: email-import.
  --caption <text>     Caption note applied to every imported photo.
  --recursive          Recurse through subdirectories.
  --dry-run            Print what would be imported without copying/appending.
  --help               Show this help.
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const args = {
    src: join(repoRoot, 'evals/photo/inbox'),
    fixtures: join(repoRoot, 'evals/photo/fixtures'),
    labels: join(repoRoot, 'evals/photo/labels.jsonl'),
    source: 'email-import',
    caption: '',
    recursive: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') usage(0)
    if (arg === '--src') args.src = resolve(argv[++i])
    else if (arg === '--fixtures') args.fixtures = resolve(argv[++i])
    else if (arg === '--labels') args.labels = resolve(argv[++i])
    else if (arg === '--source') args.source = String(argv[++i] ?? '')
    else if (arg === '--caption') args.caption = String(argv[++i] ?? '')
    else if (arg === '--recursive') args.recursive = true
    else if (arg === '--dry-run') args.dryRun = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function walk(path, recursive) {
  if (!existsSync(path)) throw new Error(`Source not found: ${path}`)
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  if (!stat.isDirectory()) return []
  const files = []
  for (const name of readdirSync(path)) {
    const child = join(path, name)
    const childStat = statSync(child)
    if (childStat.isDirectory()) {
      if (recursive) files.push(...walk(child, recursive))
    } else if (childStat.isFile()) {
      files.push(child)
    }
  }
  return files
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'photo'
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readExistingLabels(path) {
  const hashes = new Set()
  const files = new Set()
  if (!existsSync(path)) return { hashes, files }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed)
      if (row.sha256) hashes.add(row.sha256)
      if (row.file) files.add(row.file)
    } catch {
      // The eval runner will report malformed JSONL. Ingest should not make
      // things worse by trying to rewrite a human-maintained labels file.
    }
  }
  return { hashes, files }
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function todoLabel({ id, file, hash, source, caption, originalName }) {
  return {
    id,
    file,
    caption,
    source,
    original_name: originalName,
    imported_at: new Date().toISOString(),
    sha256: hash,
    license: 'internal-eval-only',
    label_status: 'needs_label',
    expected: {},
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const files = walk(args.src, args.recursive)
    .filter((file) => IMAGE_EXTS.has(extname(file).toLowerCase()))
    .sort()

  const existing = readExistingLabels(args.labels)
  const seenThisRun = new Set()
  const imports = []
  const skipped = []

  for (const file of files) {
    const hash = sha256(file)
    const shortHash = hash.slice(0, 12)
    if (existing.hashes.has(hash) || seenThisRun.has(hash)) {
      skipped.push({ file, reason: 'duplicate-sha256' })
      continue
    }
    seenThisRun.add(hash)

    const ext = extname(file).toLowerCase() || '.jpg'
    const base = slugify(basename(file))
    let targetName = `${today()}-${base}-${shortHash}${ext}`
    let n = 2
    while (existing.files.has(targetName) || existsSync(join(args.fixtures, targetName))) {
      targetName = `${today()}-${base}-${shortHash}-${n}${ext}`
      n += 1
    }

    const id = targetName.replace(/\.[a-z0-9]+$/i, '')
    imports.push({
      sourcePath: file,
      targetName,
      targetPath: join(args.fixtures, targetName),
      label: todoLabel({
        id,
        file: targetName,
        hash,
        source: args.source,
        caption: args.caption,
        originalName: basename(file),
      }),
    })
  }

  if (!args.dryRun) {
    mkdirSync(args.fixtures, { recursive: true })
    mkdirSync(dirname(args.labels), { recursive: true })
    for (const item of imports) {
      copyFileSync(item.sourcePath, item.targetPath)
      appendFileSync(args.labels, `${JSON.stringify(item.label)}\n`)
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dry_run: args.dryRun,
    src: args.src,
    fixtures: args.fixtures,
    labels: args.labels,
    imported: imports.map((item) => ({
      from: relative(repoRoot, item.sourcePath),
      to: relative(repoRoot, item.targetPath),
      id: item.label.id,
    })),
    skipped,
    next_steps: imports.length
      ? [
          'Open evals/photo/labels.jsonl and replace expected:{} for each new row with coarse labels.',
          'Run make eval-photo-dry after labeling.',
        ]
      : [],
  }, null, 2))
}

main()
