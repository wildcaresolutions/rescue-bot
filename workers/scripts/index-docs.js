#!/usr/bin/env node
/**
 * Index RAG documents into Cloudflare Vectorize
 *
 * Reads all .txt files from resources/ and site/resources/, chunks them,
 * embeds with Workers AI (bge-base-en-v1.5), and upserts to Vectorize.
 *
 * Usage:
 *   node workers/scripts/index-docs.js
 *
 * Required env vars (from .env):
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *
 * Optional:
 *   VECTORIZE_INDEX=wildcare-docs   (default)
 *   SITE_TENANT_ID=wc-...           (tenant_id for site/resources chunks)
 *   DRY_RUN=1                       (embed + print, don't upsert)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

// Load .env
const envPath = path.join(ROOT, '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) process.env[m[1]] ??= m[2]
  }
}

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.ACCOUNT_ID
const INDEX_NAME = process.env.VECTORIZE_INDEX || 'wildcare-docs'
const DRY_RUN = process.env.DRY_RUN === '1'
const SITE_TENANT_ID = process.env.SITE_TENANT_ID || process.env.TENANT_ID || 'wc-0001-wildcare-0001'

if (!CF_TOKEN || !CF_ACCOUNT) {
  console.error('ERROR: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required')
  process.exit(1)
}

const VEC_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/vectorize/v2/indexes/${INDEX_NAME}`
const AI_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/baai/bge-base-en-v1.5`
const CF_HEADERS = {
  Authorization: `Bearer ${CF_TOKEN}`,
  'Content-Type': 'application/json',
}

// ── Species & Metadata Extraction ───────────────────────────────────────────

// Filename → token lookup, derived from the shared catalog. Two stages:
//   1. Exact filename match — every builtin guide hits this in one lookup.
//   2. Substring keyword match — for site-resource files like
//      "sick_coyote_mange_faq.txt" that don't have a catalog entry but
//      still belong to a species bucket. Each entry's filename_keywords
//      list (defaults to [token]) is checked as a substring against the
//      lowercased filename.
const catalogJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/species-catalog.json'), 'utf8'))
const FILENAME_TO_TOKEN = {}
const KEYWORD_RULES = []
for (const sp of catalogJson.species) {
  if (sp.filename) FILENAME_TO_TOKEN[sp.filename] = sp.token
  const kws = sp.filename_keywords || [sp.token]
  for (const kw of kws) KEYWORD_RULES.push([kw.toLowerCase(), sp.token])
}

function extractSpecies(filename) {
  if (FILENAME_TO_TOKEN[filename]) return FILENAME_TO_TOKEN[filename]
  const lower = filename.toLowerCase()
  for (const [kw, token] of KEYWORD_RULES) {
    if (lower.includes(kw)) return token
  }
  return 'general'
}

function extractDocType(filename, prefix) {
  if (prefix === 'site') {
    if (filename.includes('transport')) return 'transport'
    if (filename.includes('contact') || filename.includes('hours')) return 'contact'
    if (filename.includes('faq') || filename.includes('mange')) return 'faq'
  }
  return 'rescue_guide'
}

function extractSection(chunkText) {
  const stepMatch = chunkText.match(/RESCUE STEP (\d+)/)
  if (stepMatch) return `step_${stepMatch[1]}`
  const sectionMatch = chunkText.match(/SECTION (\d+[A-Z]?)/i)
  if (sectionMatch) return `section_${sectionMatch[1]}`
  if (/ALWAYS INCLUDE/i.test(chunkText) && chunkText.length < 600) return 'safety'
  if (/^SUMMARY$/m.test(chunkText)) return 'summary'
  return 'intro'
}

function extractAgeTargets(chunkText) {
  const ages = new Set()
  for (const m of chunkText.matchAll(/\*\*IF animal age is (\w+)/gi)) {
    ages.add(m[1].toLowerCase())
  }
  return ages.size ? [...ages].join(',') : ''
}

// ── Semantic Chunking ───────────────────────────────────────────────────────

const MAX_CHUNK = 1500
const TARGET_CHUNK = 1200

// Vectorize IDs must be <= 64 bytes. Use a 6-char hash of the filename.
function shortId(source) {
  let h = 5381
  for (let i = 0; i < source.length; i++) h = ((h << 5) + h) ^ source.charCodeAt(i)
  return (h >>> 0).toString(36).padStart(6, '0')
}

// Section boundary patterns — these mark logical divisions in rescue guides
const SECTION_BOUNDARY_RE = /^(?=RESCUE STEP \d|SECTION \d|Section \d|DOCUMENT:|ALWAYS INCLUDE[:\s]|SUMMARY$|\*\*IF species is|\*\*IF \{contact_time\}|### )/m

// Fallback paragraph splitter for oversized sections
function splitAtParagraphs(text, target) {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const chunks = []
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > target && current.length > 0) {
      chunks.push(current.trim())
      current = para
    } else {
      current = current ? current + '\n\n' + para : para
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

function semanticChunkText(text, _source) {
  const trimmed = text.trim()

  // Small documents stay as a single chunk
  if (trimmed.length < 1200) {
    return [trimmed]
  }

  // Split at structural boundaries
  const rawSections = trimmed.split(SECTION_BOUNDARY_RE).map(s => s.trim()).filter(Boolean)

  // Merge **IF conditional blocks into their parent section
  let merged = []
  for (const section of rawSections) {
    if (section.startsWith('**IF') && merged.length > 0) {
      merged[merged.length - 1] += '\n\n' + section
    } else {
      merged.push(section)
    }
  }

  // Merge tiny fragments (< 100 chars, e.g. bare header lines) into the next section
  const consolidated = []
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].length < 100 && i + 1 < merged.length) {
      merged[i + 1] = merged[i] + '\n\n' + merged[i + 1]
    } else {
      consolidated.push(merged[i])
    }
  }
  merged = consolidated

  // Within each RESCUE STEP / SECTION, also merge any **IF lines that appear
  // as separate paragraphs (they may not have been split by the boundary regex
  // but could be separate paragraphs within a step)
  // This is already handled since **IF blocks between steps get merged above.

  // Size-limit: split oversized merged sections at paragraph boundaries
  const chunks = []
  for (const section of merged) {
    if (section.length <= MAX_CHUNK) {
      chunks.push(section)
    } else {
      chunks.push(...splitAtParagraphs(section, TARGET_CHUNK))
    }
  }

  // Final pass: merge any remaining tiny fragments (< 100 chars) into their neighbor
  const final = []
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].length < 100 && i + 1 < chunks.length) {
      chunks[i + 1] = chunks[i] + '\n\n' + chunks[i + 1]
    } else {
      final.push(chunks[i])
    }
  }

  return final
}

function chunkDocument(text, source, prefix) {
  const sid = shortId(source)
  const species = extractSpecies(source)
  const category = prefix // 'generic' or 'site'
  const filename = source.split('/').pop() || source
  const docType = extractDocType(filename, prefix)

  const rawChunks = semanticChunkText(text, source)

  return rawChunks.map((chunkText, i) => ({
    id: `${sid}_${i}`,
    text: chunkText,
    source,
    species,
    category,
    tenant_id: prefix === 'generic' ? 'shared' : SITE_TENANT_ID,
    doc_type: docType,
    section: extractSection(chunkText),
    has_age_conditional: /\*\*IF animal age/i.test(chunkText),
    age_targets: extractAgeTargets(chunkText),
  }))
}

function loadDocs() {
  const docDirs = [
    { dir: path.join(ROOT, 'resources'), prefix: 'generic' },
    { dir: path.join(ROOT, 'site', 'resources'), prefix: 'site' },
  ]
  const chunks = []
  for (const { dir, prefix } of docDirs) {
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.txt')) continue
      const text = fs.readFileSync(path.join(dir, file), 'utf8')
      const source = `${prefix}/${file}`
      chunks.push(...chunkDocument(text, source, prefix))
    }
  }
  return chunks
}

// ── Embed via Workers AI REST API (bge-base-en-v1.5 768d) ───────────────────

async function embedBatch(texts) {
  const res = await fetch(AI_BASE, {
    method: 'POST',
    headers: CF_HEADERS,
    body: JSON.stringify({ text: texts }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Embed failed (${res.status}): ${err}`)
  }
  const data = await res.json()
  return data.result?.data ?? data.result?.embeddings ?? data.data
}

// ── Vectorize ────────────────────────────────────────────────────────────────

async function upsertBatch(vectors) {
  // Vectorize upsert uses NDJSON — include rich metadata for filtering
  const ndjson = vectors
    .map(v => JSON.stringify({
      id: v.id,
      values: v.values,
      metadata: {
        text: v.text,
        source: v.source,
        species: v.species,
        category: v.category,
        tenant_id: v.tenant_id,
        doc_type: v.doc_type,
        section: v.section,
        has_age_conditional: v.has_age_conditional,
        age_targets: v.age_targets,
      },
    }))
    .join('\n')

  const res = await fetch(`${VEC_BASE}/upsert`, {
    method: 'POST',
    headers: { ...CF_HEADERS, 'Content-Type': 'application/x-ndjson' },
    body: ndjson,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Upsert failed (${res.status}): ${err}`)
  }
  return res.json()
}

// ── Main ─────────────────────────────────────────────────────────────────────

const EMBED_BATCH = 50
const UPSERT_BATCH = 100

async function main() {
  console.log('Loading documents from resources/ and site/resources/...')
  const chunks = loadDocs()
  console.log(`  ${chunks.length} chunks from ${new Set(chunks.map(c => c.source.split('__')[0])).size} documents`)

  if (DRY_RUN) {
    console.log('\nDRY RUN — all chunks:\n')
    const bySource = {}
    for (const c of chunks) {
      ;(bySource[c.source] ??= []).push(c)
    }
    for (const [source, sourceChunks] of Object.entries(bySource)) {
      console.log(`  📄 ${source} (${sourceChunks.length} chunks, species=${sourceChunks[0].species}, type=${sourceChunks[0].doc_type})`)
      for (const c of sourceChunks) {
        const age = c.age_targets ? ` ages=[${c.age_targets}]` : ''
        console.log(`     [${c.id}] ${c.section} (${c.text.length} chars)${age} — ${c.text.slice(0, 60).replace(/\n/g, ' ')}...`)
      }
    }
    console.log(`\n  Total: ${chunks.length} chunks from ${Object.keys(bySource).length} documents`)
    return
  }

  // Embed in batches
  console.log(`\nEmbedding ${chunks.length} chunks (batch=${EMBED_BATCH})...`)
  const withVectors = []
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH)
    process.stdout.write(`  ${i}/${chunks.length}\r`)
    const embeddings = await embedBatch(batch.map(c => c.text))
    for (let j = 0; j < batch.length; j++) {
      withVectors.push({ ...batch[j], values: embeddings[j] })
    }
  }
  console.log(`  ${chunks.length}/${chunks.length} — done`)

  // Upsert in batches
  console.log(`\nUpserting to Vectorize index "${INDEX_NAME}"...`)
  let total = 0
  for (let i = 0; i < withVectors.length; i += UPSERT_BATCH) {
    const batch = withVectors.slice(i, i + UPSERT_BATCH)
    const result = await upsertBatch(batch)
    total += result.result?.count ?? batch.length
    process.stdout.write(`  ${i + batch.length}/${withVectors.length}\r`)
  }
  console.log(`  ${withVectors.length}/${withVectors.length} — done`)
  console.log(`\n✓ Indexed ${total} vectors into "${INDEX_NAME}"`)
}

main().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
