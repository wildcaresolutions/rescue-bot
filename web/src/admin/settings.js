// The Settings drawer is retired. Org info, domains, team, and daily report
// now live in the Playbook (Setup + Account tabs), and the header gear is
// gone. These exports remain only because admin.js calls bindSettings and
// test-cases.js calls openSettings ("Open Settings" on a failed test) — both
// now just route into the Playbook.

import { setKbTab } from './playbook.js'

let _showKbView = null
export function bindSettings({ showKbView }) { _showKbView = showKbView }

/** Open the Playbook on the Setup tab (where org facts now live). */
export function openSettings() {
  setKbTab('setup')
  if (_showKbView) _showKbView()
  setTimeout(() => document.getElementById('pb-org')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
}

export function closeSettings() { /* retired — Settings lives in the Playbook */ }
