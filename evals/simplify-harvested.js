#!/usr/bin/env node
/**
 * Simplify harvested scenarios to reduce token costs
 *
 * Problem: Harvested scenarios have massive `semantic_similarity_to` fields
 * containing full response text (500+ tokens per scenario). This:
 * 1. Burns tokens unnecessarily
 * 2. Makes judge unreliable (LLM can't accurately judge semantic similarity)
 * 3. Slows down evals
 *
 * Solution: Extract essential criteria from the full response text
 */

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Safety keywords that MUST be detected
const SAFETY_KEYWORDS = {
  rabies: /rabies|rabies-vector/i,
  gloves: /gloves?|leather gloves|thick gloves|protective gear/i,
  animalControl: /animal control/i,
  marinHumane: /marin humane/i,
  doNotTouch: /do not touch|don't touch|never touch|avoid touching/i,
  doNotFeed: /do not feed|don't feed|never feed|no food|avoid feeding/i,
  doNotWater: /do not (give )?water|don't water|no water|avoid water/i,
  professionalOnly: /professional (handling|removal) only|call (a )?professional/i,
  eyeProtection: /eye protection|safety goggles|protect.{0,20}eyes/i,
  warmth: /warm|heat|heating pad|hot water bottle/i,
  container: /box|container|carrier|crate|basket/i,
  towel: /towel|cloth|blanket/i,
  sugarWater: /sugar water|sugar solution/i,
  crofab: /crofab\.com|antivenom/i,
  fiveCs: /5 C's|five C's|crying.*coming.*covered.*cold.*caught/i,
}

// Contact info that should be mentioned
const CONTACT_INFO = {
  wildcarePhone: /\(415\) 456-SAVE|\(415\) 300-6359|415-456-SAVE|415-300-6359/,
  wildcareAddress: /76 Albert (Ave|Avenue)|San Rafael/i,
  peninsulaHumane: /Peninsula Humane|650-340-7022/i,
}

/**
 * Extract required keywords from response text
 */
function extractRequiredKeywords(text) {
  const required = []

  // Check for safety keywords
  for (const [key, regex] of Object.entries(SAFETY_KEYWORDS)) {
    if (regex.test(text)) {
      // Map to more general terms for matching
      const mappings = {
        rabies: 'rabies',
        gloves: 'gloves',
        animalControl: 'Animal Control',
        marinHumane: 'Marin Humane',
        doNotTouch: 'do not touch',
        doNotFeed: 'do not feed',
        doNotWater: 'do not give water',
        professionalOnly: 'professional handling',
        eyeProtection: 'eye protection',
        warmth: 'warmth',
        container: 'box',
        towel: 'towel',
        sugarWater: 'sugar water',
        crofab: 'crofab.com',
        fiveCs: '5 Cs',
      }

      if (mappings[key] && !required.includes(mappings[key])) {
        required.push(mappings[key])
      }
    }
  }

  // Check for contact info
  for (const [key, regex] of Object.entries(CONTACT_INFO)) {
    if (regex.test(text)) {
      if (key === 'wildcarePhone') required.push('WildCare phone')
      if (key === 'wildcareAddress') required.push('WildCare address')
      if (key === 'peninsulaHumane') required.push('Peninsula Humane')
    }
  }

  return required
}

/**
 * Extract forbidden actions from response text
 */
function extractForbidden(text) {
  const forbidden = []

  // Things that should NOT be in the response
  const forbiddenPatterns = {
    'bare hands': /bare hands|without gloves/i,
    'feed': /feed|give food|offer food|provide food/i,
    'water': /give water|offer water|provide water/i,
    'bring inside': /bring (it |them )?inside|take (it |them )?indoors/i,
    'keep as pet': /keep (as )?(a )?pet|adopt|domesticate/i,
  }

  // Only add forbidden if text explicitly warns against it
  // (we don't want false positives)
  for (const [key, regex] of Object.entries(forbiddenPatterns)) {
    if (regex.test(text)) {
      // Check if it's in a "do not" context
      const doNotContext = new RegExp(`(do not|don't|never|avoid).{0,30}${key}`, 'i')
      if (!doNotContext.test(text)) {
        // It's mentioned without warning - might be forbidden
        // But let's be conservative and not add it
      }
    }
  }

  return forbidden
}

/**
 * Determine if semantic similarity check is needed
 * (only for complex responses that can't be reduced to keywords)
 */
function needsSemanticSimilarity(text) {
  // If response is very short, keyword matching is sufficient
  if (text.length < 200) return false

  // If response contains complex medical/safety advice, keep semantic check
  // but use a much shorter reference
  const complexPatterns = [
    /concussion|internal (injuries|bleeding)/i,
    /rabies exposure|post-exposure prophylaxis/i,
    /antivenom|envenomation/i,
    /fledgling.{0,50}nestling/i,
    /torpor|hypothermi/i,
  ]

  return complexPatterns.some(pattern => pattern.test(text))
}

/**
 * Create shortened reference for semantic similarity
 * (extract first 2-3 key sentences instead of full response)
 */
function createShortReference(text) {
  // Extract first sentence with safety warning
  const safetyMatch = text.match(/([^.!?]*(?:rabies|danger|do not|never|warning)[^.!?]*[.!?])/i)

  // Extract first sentence with action items
  const actionMatch = text.match(/([^.!?]*(?:immediately|first|step|action)[^.!?]*[.!?])/i)

  const parts = []
  if (safetyMatch) parts.push(safetyMatch[1].trim())
  if (actionMatch && actionMatch[1] !== safetyMatch?.[1]) {
    parts.push(actionMatch[1].trim())
  }

  // Limit to 150 chars max
  const reference = parts.join(' ').substring(0, 150)
  return reference || text.substring(0, 150)
}

/**
 * Simplify a single scenario
 */
function simplifyScenario(scenario) {
  const { criteria, ...rest } = scenario
  const { semantic_similarity_to, ...otherCriteria } = criteria

  if (!semantic_similarity_to) {
    // Already simplified
    return scenario
  }

  console.log(`  Simplifying: ${scenario.id}`)
  console.log(`    Original length: ${semantic_similarity_to.length} chars`)

  // Extract keywords
  const required = extractRequiredKeywords(semantic_similarity_to)
  const forbidden = extractForbidden(semantic_similarity_to)

  // Decide if we need semantic similarity
  const newCriteria = {
    ...otherCriteria,
    safety_first: true,
    required,
  }

  if (forbidden.length > 0) {
    newCriteria.forbidden = forbidden
  }

  // For complex scenarios, add shortened reference
  if (needsSemanticSimilarity(semantic_similarity_to)) {
    newCriteria.semantic_similarity_to = createShortReference(semantic_similarity_to)
    console.log(`    New reference length: ${newCriteria.semantic_similarity_to.length} chars (reduced by ${Math.round((1 - newCriteria.semantic_similarity_to.length / semantic_similarity_to.length) * 100)}%)`)
  } else {
    console.log('    Converted to keyword matching (no semantic check needed)')
  }

  console.log(`    Required keywords: ${required.join(', ')}`)

  return {
    ...rest,
    criteria: newCriteria,
  }
}

/**
 * Main execution
 */
function main() {
  const harvestedDir = join(__dirname, 'scenarios', 'harvested')
  const inputFile = process.argv[2] || join(harvestedDir, 'batch_1766685764725.json')

  console.log(`Reading: ${inputFile}`)
  const scenarios = JSON.parse(readFileSync(inputFile, 'utf-8'))

  console.log(`\nProcessing ${scenarios.length} scenarios...\n`)

  const simplified = scenarios.map(simplifyScenario)

  // Write to new file
  const outputFile = inputFile.replace('.json', '_simplified.json')
  writeFileSync(outputFile, JSON.stringify(simplified, null, 2))

  console.log(`\n✓ Wrote simplified scenarios to: ${outputFile}`)

  // Calculate savings
  const originalSize = JSON.stringify(scenarios).length
  const newSize = JSON.stringify(simplified).length
  const savings = Math.round((1 - newSize / originalSize) * 100)

  console.log(`\nSize reduction: ${originalSize} → ${newSize} bytes (${savings}% smaller)`)
  console.log(`Token savings: ~${Math.round((originalSize - newSize) / 4)} tokens per eval run\n`)
}

main()
