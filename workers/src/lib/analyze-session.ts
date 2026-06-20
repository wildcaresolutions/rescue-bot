/**
 * quickAnalyzeSession — regex-based triage analyzer that runs after each
 * chat message append (and during backfill for imported sessions).
 *
 * Kept in lib/ so that lib/backfill.ts and routes/chat.ts can both import it
 * without introducing a lib→routes cross-layer dependency.
 */
import { parseOrgConfig } from './tenant-loader'
import { matchTriage, type TenantTriageRule } from './match-triage'

export async function quickAnalyzeSession(db: D1Database, tenantId: string, sessionId: string, deviceType = 'unknown') {
  const { results: msgs } = await db.prepare(
    `SELECT role, content FROM messages WHERE session_id = ? AND tenant_id = ? AND message_type = 'chat' ORDER BY timestamp ASC LIMIT 50`,
  ).bind(sessionId, tenantId).all()

  // Threshold is <2 (not <3) because callers sometimes dump a full report —
  // species, situation, name, phone — into a single user message, bot replies
  // once, conversation ends. Skipping those at <3 hides legitimate action
  // items (e.g. callers who left contact info in one block).
  if (msgs.length < 2) return

  const allContent = msgs.map(m => (m.content as string || '').toLowerCase()).join(' ')
  const userContent = msgs.filter(m => m.role === 'user').map(m => (m.content as string || '').toLowerCase()).join(' ')

  // Detect contact info (callback requested)
  const hasPhone = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(allContent) &&
    msgs.some(m => m.role === 'user' && /\d{3}[-.]?\d{3}[-.]?\d{4}/.test(m.content as string))
  const hasEmail = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/.test(userContent)
  const requestsCallback = /call me|contact me|please call|my (name|number|email|phone) is|reach me/i.test(userContent)
  const hasContactInfo = hasPhone || hasEmail || requestsCallback

  // Extract contact info
  let contactInfo: string | null = null
  if (hasContactInfo) {
    const phoneMatch = userContent.match(/\b(\d{3}[-.]?\d{3}[-.]?\d{4})\b/)
    const emailMatch = userContent.match(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/)
    const nameMatch = userContent.match(/my name is ([a-z]+ ?[a-z]*)/i)
    contactInfo = JSON.stringify({
      phone: phoneMatch?.[1] || null,
      email: emailMatch?.[1] || null,
      name: nameMatch?.[1] || null,
    })
  }

  // Detect urgency — tenant rules override defaults, defaults fill in gaps
  const tenantRow = await db.prepare('SELECT org_config FROM tenants WHERE id = ?').bind(tenantId).first<{ org_config: string | null }>()
  const orgCfg = parseOrgConfig(tenantRow?.org_config)
  const tenantRules = orgCfg.triage_config as TenantTriageRule[] | undefined

  const triage = matchTriage(userContent, tenantRules)
  const urgency = triage.urgency
  const triageHint: string | null = triage.hint

  // Detect animal type
  let animal: string | null = null
  const animalPatterns: Array<[RegExp, string]> = [
    [/raccoon|coon/i, 'raccoon'], [/bat\b/i, 'bat'], [/hawk|owl|eagle|raptor|falcon/i, 'raptor'],
    [/squirrel/i, 'squirrel'], [/opossum|possum/i, 'opossum'], [/deer|fawn/i, 'deer'],
    [/hummingbird/i, 'hummingbird'], [/snake|rattlesnake/i, 'snake'], [/coyote/i, 'coyote'],
    [/pelican/i, 'pelican'], [/goose|duck/i, 'waterfowl'], [/gull|seagull/i, 'gull'],
    [/bird|robin|sparrow|finch|jay|crow|dove|pigeon/i, 'songbird'],
    [/heron|egret/i, 'heron/egret'],
  ]
  for (const [pattern, name] of animalPatterns) {
    if (pattern.test(userContent)) { animal = name; break }
  }

  // Simple outcome detection
  let outcome = 'unknown'
  const lastAssistant = msgs.filter(m => m.role === 'assistant').pop()
  const lastContent = (lastAssistant?.content as string || '').toLowerCase()
  if (/call us|bring.*to|come to|intake/i.test(lastContent)) outcome = 'bringing_in'
  else if (/leave.*alone|monitor|watch|mom.*return|reunif/i.test(lastContent)) outcome = 'resolved'
  else if (/outside.*service|not.*our.*area|redirect|peninsula|sacramento/i.test(lastContent)) outcome = 'redirected'

  // Check feedback
  const hasFeedback = await db.prepare(
    'SELECT rating FROM feedback WHERE session_id = ? AND tenant_id = ? LIMIT 1',
  ).bind(sessionId, tenantId).first()

  // Determine if this needs action.
  //
  // Per WildCare ops: front-desk only follows up on conversations where the
  // caller left contact info (name/phone/email or explicit callback request).
  // Urgency labels are still computed (and visible in the report) but they
  // don't gate "needs follow-up" — without contact info there's no one to
  // follow up with.
  //
  // A negative feedback rating still flags for follow-up so we can review
  // bad bot answers even when the caller didn't share contact info.
  const needsAction = (hasContactInfo || (hasFeedback && hasFeedback.rating === 0)) ? 1 : 0

  // Generate a brief situation summary
  const firstUserMsg = msgs.find(m => m.role === 'user')?.content as string || ''
  const situation = firstUserMsg.slice(0, 200)

  // Detect service area (simple: check if redirected)
  const inServiceArea = outcome === 'redirected' ? 0 : 1

  // Delete + insert (no unique constraint migration dependency)
  await db.prepare(
    'DELETE FROM session_analysis WHERE session_id = ? AND tenant_id = ?',
  ).bind(sessionId, tenantId).run()

  await db.prepare(`
    INSERT INTO session_analysis (session_id, tenant_id, urgency, outcome, animal, situation, in_service_area, needs_action, contact_info, device_type, triage_hint, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(sessionId, tenantId, urgency, outcome, animal, situation, inServiceArea, needsAction, contactInfo, deviceType, triageHint).run()
}
