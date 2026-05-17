// Default widget configuration.
// Can be overridden via window.RescueBotChat (or legacy window.WildCareChat)
// before loading widget.js. The runtime /api/config endpoint provides
// per-tenant overrides (name, tagline, brand colors); the values below
// are the build-time fallback that ships in the widget bundle for the
// brief window before /api/config returns.
const site = {
  name: 'Rescue Bot',
  tagline: 'Wildlife Rescue Assistant',
  service_area: '',
  branding: {
    primary_color: '#78a12e',
    secondary_color: '#004863',
  },
}

const area = site.service_area ? ` in the ${site.service_area} area` : ''

export const DEFAULT_WIDGET_CONFIG = {
  autoOpen: true,
  agentName: `${site.name} ${site.tagline}`,
  buttonLabel: 'Chat',
  welcomeMessage: `Hello! I'm here to help you with injured or abandoned wildlife${area}.`,
  position: 'bottom-right',
  // Position overrides for button and pane (CSS values, e.g. { bottom: '100px', left: '20px', right: 'auto' })
  buttonPosition: null,
  panePosition: null,
  // Size options (CSS values)
  width: '90%',
  maxWidth: '600px',
  height: 'auto',
  maxHeight: '80vh',
  minWidth: '320px',
  minHeight: '400px',
  resizable: true, // Allow user to drag-resize
  theme: {
    primaryColor: site.branding?.primary_color || '#78a12e',
    secondaryColor: site.branding?.secondary_color || '#004863',
    textColor: '#333333',
  },
}

export function getWidgetConfig() {
  // Support both new (RescueBotChat) and legacy (WildCareChat) config names
  const userConfig = typeof window !== 'undefined'
    ? (window.RescueBotChat || window.WildCareChat || {})
    : {}
  return {
    ...DEFAULT_WIDGET_CONFIG,
    ...userConfig,
    // Deep merge theme
    theme: { ...DEFAULT_WIDGET_CONFIG.theme, ...userConfig.theme },
  }
}
