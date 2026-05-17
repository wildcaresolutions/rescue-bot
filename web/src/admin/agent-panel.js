// Agent panel expand/collapse/fullscreen state machine.
//
// The panel itself (button bar, message list, input) is built by the admin
// portal shell; this module only owns the open/closed state and toggles the
// CSS classes that drive the slide-in/slide-out animation.

let agentExpanded = false
let agentFullscreen = false

export function isAgentExpanded() { return agentExpanded }
export function setAgentExpanded(v) { agentExpanded = !!v }
export function isAgentFullscreen() { return agentFullscreen }

export function expandAgent() {
  agentExpanded = true
  const panel = document.getElementById('agentPanel')
  panel.classList.remove('collapsed')
  panel.classList.add('expanded')
  document.getElementById('agentInput')?.focus()
}

export function collapseAgent() {
  agentExpanded = false
  agentFullscreen = false
  const panel = document.getElementById('agentPanel')
  panel.classList.remove('expanded', 'fullscreen')
  panel.classList.add('collapsed')
}

export function expandAgentFullscreen() {
  agentExpanded = true
  agentFullscreen = true
  const panel = document.getElementById('agentPanel')
  panel.classList.remove('collapsed')
  panel.classList.add('expanded', 'fullscreen')
  document.getElementById('agentInput')?.focus()
}

export function toggleAgentFullscreen() {
  if (agentFullscreen) {
    agentFullscreen = false
    const panel = document.getElementById('agentPanel')
    panel.classList.remove('fullscreen')
  } else {
    expandAgentFullscreen()
  }
}

export function exitAgentFullscreen() {
  agentFullscreen = false
  const panel = document.getElementById('agentPanel')
  panel?.classList.remove('fullscreen')
}
