// The Settings drawer is retired. Everything it held — Organization info,
// Daily Report, Allowed Domains, Team Members — now lives on the single
// consolidated Playbook page (web/src/admin/playbook.js). The gear icon and
// any "Open Settings" shortcut just navigate there, scrolled to the relevant
// section, so there is one place to enter information instead of a separate
// drawer that duplicated half of it.
//
// These exports are kept (admin.js + test-cases.js import them) but now route
// into the Playbook instead of opening a drawer.

let _showKbView = null

export function bindSettings({ showKbView }) {
  _showKbView = showKbView
}

/** Open the consolidated Playbook. `section` is an optional element id to
 *  scroll to (e.g. 'pb-org' for the old "Organization Info", 'pb-site' for
 *  domains/team/report). Defaults to the Organization section since that's
 *  what the old Settings drawer led with. */
export function openSettings(section = 'pb-org') {
  if (_showKbView) _showKbView()
  // Let the Playbook render, then scroll to the requested section.
  setTimeout(() => {
    const el = document.getElementById(typeof section === 'string' ? section : 'pb-org')
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 60)
}

// No drawer to close anymore; kept as a no-op so existing callers don't break.
export function closeSettings() { /* retired — Settings lives in the Playbook */ }
