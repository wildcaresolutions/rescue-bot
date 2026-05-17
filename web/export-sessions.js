#!/usr/bin/env node
/**
 * Export all chat sessions for evaluation
 *
 * Usage: node export-sessions.js [output-file]
 *
 * Fetches all sessions from the cagent API and exports them as JSON
 * for building evals and analyzing user interactions.
 */

import { writeFileSync } from 'fs'

const API_BASE = process.env.API_BASE || 'http://localhost:8080/api'

async function exportSessions() {
  try {
    console.log('Fetching sessions from', API_BASE)

    const response = await fetch(`${API_BASE}/sessions`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const sessions = await response.json()
    console.log(`Found ${sessions.length} sessions`)

    // Fetch full details for each session
    const detailedSessions = []
    for (const session of sessions) {
      console.log(`Fetching session ${session.id}...`)
      const detailResponse = await fetch(`${API_BASE}/sessions/${session.id}`)
      if (detailResponse.ok) {
        const detail = await detailResponse.json()
        detailedSessions.push(detail)
      }
    }

    // Output file
    const outputFile = process.argv[2] || `sessions-export-${Date.now()}.json`

    const exportData = {
      exported_at: new Date().toISOString(),
      total_sessions: detailedSessions.length,
      sessions: detailedSessions,
    }

    writeFileSync(outputFile, JSON.stringify(exportData, null, 2))
    console.log(`\nExported ${detailedSessions.length} sessions to ${outputFile}`)

    // Print summary stats
    let totalMessages = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0

    detailedSessions.forEach(s => {
      totalMessages += s.messages?.length || 0
      totalInputTokens += s.input_tokens || 0
      totalOutputTokens += s.output_tokens || 0
    })

    console.log('\nSummary:')
    console.log(`  Total messages: ${totalMessages}`)
    console.log(`  Total input tokens: ${totalInputTokens.toLocaleString()}`)
    console.log(`  Total output tokens: ${totalOutputTokens.toLocaleString()}`)

  } catch (error) {
    console.error('Error exporting sessions:', error.message)
    process.exit(1)
  }
}

exportSessions()
