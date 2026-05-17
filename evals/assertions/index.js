/**
 * Custom Assertion Registry
 * Exports all assertion functions and registers them globally for promptfoo
 */

import { semanticMatchAssertion } from './semantic-match.js'
import { semanticForbiddenAssertion } from './semantic-forbidden.js'
import { serviceAreaCheckAssertion } from './service-area.js'
import { resourceValidationAssertion } from './resource-validation.js'
import { speciesProtocolAssertion } from './species-protocol.js'
import { requiredQuestionsAssertion } from './required-questions.js'
import { safetyFirstAssertion } from './safety-first.js'
import { knownIssuesCheckAssertion } from './known-issues.js'
import { batExposureCheckAssertion } from './bat-exposure.js'
import { ragRetrievalAssertion } from './rag-retrieval.js'

// Export all assertions
export {
  semanticMatchAssertion,
  semanticForbiddenAssertion,
  serviceAreaCheckAssertion,
  resourceValidationAssertion,
  speciesProtocolAssertion,
  requiredQuestionsAssertion,
  safetyFirstAssertion,
  knownIssuesCheckAssertion,
  batExposureCheckAssertion,
  ragRetrievalAssertion,
}

// Create assertion registry
export const CUSTOM_ASSERTIONS = {
  'semantic-match': semanticMatchAssertion,
  'semantic-forbidden': semanticForbiddenAssertion,
  'service-area-check': serviceAreaCheckAssertion,
  'resource-validation': resourceValidationAssertion,
  'species-protocol': speciesProtocolAssertion,
  'required-questions': requiredQuestionsAssertion,
  'safety-first': safetyFirstAssertion,
  'known-issues-check': knownIssuesCheckAssertion,
  'bat-exposure-check': batExposureCheckAssertion,
  'rag-retrieval': ragRetrievalAssertion,
}

// Register globally for promptfoo
// This allows promptfoo's inline JavaScript assertions to access them synchronously
globalThis.CUSTOM_ASSERTIONS = CUSTOM_ASSERTIONS
