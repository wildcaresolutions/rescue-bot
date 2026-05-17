// Shared mutable state for the admin SPA.
//
// We can't directly re-export `let` bindings across modules and have writes
// in one module visible to readers in another (ESM live-binding only works
// in one direction: importer sees the exporter's writes, but the importer
// can't reassign them). So each piece of state is wrapped in a get/set pair.
//
// Modules import the accessors they need and stay decoupled. Without this
// the split would have required threading tenantConfig / activeView / etc.
// through every call site in the SPA.

const state = {
  activeView: 'feed',         // feed | reports | test | preview | kb | help
  tenantConfig: null,
  agentMessages: [],
  agentStreaming: false,
  onboardingPending: null,
}

export function getActiveView() { return state.activeView }
export function setActiveView(v) { state.activeView = v }

export function getTenantConfig() { return state.tenantConfig }
export function setTenantConfig(v) { state.tenantConfig = v }

// Agent chat / onboarding state shared across the chat input, copilot
// dispatch, deterministic onboarding flow, and the renderAgentMessages
// re-renderer. Arrays/objects are mutated in place by some call sites
// (push, splice); the setter is for full replacement (e.g. clearing
// history).
export function getAgentMessages() { return state.agentMessages }
export function setAgentMessages(v) { state.agentMessages = v }

export function isAgentStreaming() { return state.agentStreaming }
export function setAgentStreaming(v) { state.agentStreaming = !!v }

export function getOnboardingPending() { return state.onboardingPending }
export function setOnboardingPending(v) { state.onboardingPending = v }
