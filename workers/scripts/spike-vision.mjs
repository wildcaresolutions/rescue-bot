#!/usr/bin/env node
// Smoke-test Cloudflare AI Gateway /compat for the exact shape used by photo
// triage: OpenAI chat-completions messages with image_url data URLs plus JSON
// schema output. Run from repo root:
//
//   node workers/scripts/spike-vision.mjs

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')

function readEnvFile(path) {
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(line => line && !line.trimStart().startsWith('#') && line.includes('='))
      .map(line => {
        const i = line.indexOf('=')
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
      }),
  )
}

const env = {
  ...readEnvFile(join(root, 'org.env')),
  ...readEnvFile(join(root, '.env')),
  ...process.env,
}

const accountId = env.AI_GATEWAY_ACCOUNT_ID || env.ACCOUNT_ID
const gatewayId = env.AI_GATEWAY_ID || 'default'
const token = env.AI_GATEWAY_TOKEN
const model = env.PHOTO_RECOGNIZER_MODEL || 'google-ai-studio/gemini-3.1-flash-image-preview'

function redactSensitive(value) {
  return String(value)
    .replace(/cfut_[A-Za-z0-9_-]+/g, 'cfut_[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]+/g, 'AIza[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]')
    .replace(/postgresql:\/\/[^\s"')]+/g, 'postgresql://[REDACTED]')
}

if (!accountId || !token) {
  console.error('ERROR: set AI_GATEWAY_ACCOUNT_ID or ACCOUNT_ID, plus AI_GATEWAY_TOKEN.')
  process.exit(1)
}

const tinyRedJpegBase64 = [
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD',
  'AAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkS',
  'Ew8UHRofHh0aHBwgJC4nICIsIxwcKDcp',
  'LDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAB',
  'AAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAA',
  'AAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA',
  'AP/aAAgBAQAAPwA=',
].join('')

const body = {
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Return structured metadata for this uploaded image.' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${tinyRedJpegBase64}`,
          },
        },
      ],
    },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'photo_metadata_smoke',
      strict: false,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted_image: { type: 'boolean' },
          visible_subject: { type: 'string' },
        },
        required: ['accepted_image', 'visible_subject'],
      },
    },
  },
  max_tokens: 128,
}

const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'cf-aig-authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

const text = await res.text()
let parsed = null
try {
  parsed = JSON.parse(text)
} catch {
  // Keep parsed null.
}

console.log(JSON.stringify({
  ok: res.ok,
  status: res.status,
  model,
  content: parsed?.choices?.[0]?.message?.content ?? null,
  error: parsed?.error?.message
    ? redactSensitive(parsed.error.message)
    : parsed?.error
      ? redactSensitive(parsed.error)
      : (res.ok ? null : redactSensitive(text.slice(0, 500))),
}, null, 2))

if (!res.ok) process.exit(2)
