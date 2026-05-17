# Design System — WildCare Bot

## Product Context
- **What this is:** AI-powered wildlife rescue chatbot platform. Rehab orgs get branded bots for their websites.
- **Who it's for:** (1) Platform admin, (2) Rehab org coordinators (tenant admins), (3) Regular people with wildlife emergencies (end users via embedded widget)
- **Space/industry:** Wildlife rehabilitation, conservation nonprofit, SaaS for nonprofits
- **Project type:** Multi-tenant SaaS platform with embeddable chat widget

## Aesthetic Direction
- **Direction:** Field Notes — naturalist journal meets modern SaaS
- **Decoration level:** Intentional — botanical line illustrations (SVG), subtle paper texture on backgrounds, hand-drawn loading animation in widget
- **Mood:** Warm, paper-textured, quietly authoritative. Like opening a well-loved field naturalist's notebook. Not a charity site, not enterprise software. A well-made tool with soul.
- **Key departures:**
  1. No animal photography anywhere. Botanical SVG line illustrations only.
  2. Silent widget opening: "Describe what you're seeing." No greeting, no avatar.
  3. Parchment background instead of white.

## Typography
- **Display/Hero:** Instrument Serif — elegant, unexpected for SaaS. Field guide title page feel.
- **Body/UI:** DM Sans — clean geometric sans, better personality than Inter/Roboto.
- **Data/Tables:** Geist Mono — modern, excellent tabular-nums. Field observation log texture.
- **Loading:** Google Fonts CDN. Load Instrument Serif display-swap for marketing/admin. Widget loads only DM Sans to keep bundle minimal.
- **Scale:**
  - Display: 48-72px / Instrument Serif 400
  - Heading: 24-32px / Instrument Serif 400
  - Body: 16px / DM Sans 400-500
  - UI Labels: 13-14px / DM Sans 600, uppercase, 0.08em tracking
  - Data: 13px / Geist Mono 400

## Color
- **Approach:** Restrained earth palette. Green is expected in conservation... we just do it differently.
- **Umber:** `#3D2B1F` — primary text, headers. Warm near-black from soil and bark.
- **Parchment:** `#F6F1EB` — primary background. Unbleached paper, not white.
- **Sage:** `#6B7F5E` — primary action, links, active states. Muted forest, not bright eco-green.
- **Ochre:** `#C4883A` — warm accent. Highlights, hover states, notification badges.
- **Slate Creek:** `#4A6670` — cool accent. Admin data viz, secondary buttons.
- **Field White:** `#FDFCFA` — card surfaces, elevated elements.
- **Dried Grass:** `#D4C9B5` — borders, dividers, disabled states.
- **Urgent Red:** `#B44233` — error states, critical alerts. Terra cotta, stays in palette.
- **Canopy:** `#2D5A3D` — success states, "resolved" badges.
- **Storm:** `#8B7E74` — secondary text, captions, metadata.
- **Dark mode (admin dashboards only):**
  - Night Field: `#1A1714` (background)
  - Dusk: `#2A2520` (card surfaces)
  - Moonlight: `#E8E0D6` (primary text)
  - Accent colors (sage, ochre, slate creek) survive mode-switching without adjustment.

## Spacing
- **Base unit:** 8px
- **Density:** Comfortable on marketing, compact on admin dashboards
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Approach:** Hybrid — editorial/creative for marketing (asymmetric, generous whitespace), grid-disciplined for admin dashboards (Linear-style density)
- **Grid:** Marketing: 12-col, max-width 1100px. Admin: full-width, sidebar + content.
- **Max content width:** 1100px (marketing), full-width (admin)
- **Border radius:** sm:4px (inputs), md:8px (cards, alerts), lg:12px (modals, panels), full:9999px (badges, pills)

## Motion
- **Approach:** Minimal-functional. No bouncing, no swooping.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms)
- **Widget:** Hand-drawn pencil-sketch loading indicator (animated SVG, ~24 frames). The one expressive motion moment.

## CSS Custom Properties
```css
:root {
  --color-umber: #3D2B1F;
  --color-parchment: #F6F1EB;
  --color-sage: #6B7F5E;
  --color-ochre: #C4883A;
  --color-slate-creek: #4A6670;
  --color-field-white: #FDFCFA;
  --color-dried-grass: #D4C9B5;
  --color-urgent-red: #B44233;
  --color-canopy: #2D5A3D;
  --color-storm: #8B7E74;

  --font-display: 'Instrument Serif', serif;
  --font-body: 'DM Sans', sans-serif;
  --font-mono: 'Geist Mono', 'SF Mono', monospace;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;
}
```

## Widget Design Rules
- Opens with quiet authority: "Describe what you're seeing." No greeting, no avatar, no animation.
- Sage header with org name in Instrument Serif.
- DM Sans only (no display fonts in widget, keep bundle small).
- Hand-drawn pencil-sketch loading indicator instead of bouncing dots.
- After first message exchange, tone warms naturally through the AI response.

## Tenant Customization
- Tenants can override: primary action color (replaces sage), accent color, logo.
- Tenants cannot override: typography, spacing, border radius, layout structure.
- Each tenant picks a "region motif" (future): line-drawn branch/feather for their area.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-18 | Initial design system: Field Notes | Created by /design-consultation. Naturalist journal aesthetic chosen to differentiate from generic nonprofit/SaaS. Research: discoverwildcare.org, Ocean Conservancy, The Nature Conservancy, Linear. |
| 2026-04-18 | No animal photography | Every competitor leads with raptor photos. Botanical SVG illustrations are distinctive, lightweight, and scale perfectly. |
| 2026-04-18 | Silent widget opening | End users are in a wildlife emergency. Chatbot cheerfulness is inappropriate. Quiet authority respects the context. |
| 2026-04-18 | DM Sans over Inter | Inter is overused to the point of invisibility. DM Sans has better personality while remaining highly legible. |
