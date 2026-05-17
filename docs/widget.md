# Widget theming + embedding

The embeddable chat widget lives at `web/src/widget.js`. Operators paste a single `<script>` tag onto their site:

```html
<script src="https://embed.wildcaresolutions.org/v1.js" data-tenant="myrehab"></script>
```

The `data-tenant` value matches the tenant slug. The widget reads `/api/config` for branding + theme; no other arguments needed.

(Fork operators: the host comes from `PLATFORM_EMBED_HOST` in your `.env` and renders correctly when the copilot's `get_embed_code` tool generates the snippet.)

## CSS custom properties

22 properties cover the visual surface. Defaults in `web/src/widget-styles.css`. Tenant theme stored in `tenants.widget_theme` JSON.

### Colors

| Property | Use |
|---|---|
| `--rbot-primary` | Header bg, send button, links |
| `--rbot-secondary` | Hover/active states |
| `--rbot-header-bg` | Header override (defaults to primary) |
| `--rbot-text` | Body copy |
| `--rbot-bg` | Pane background |
| `--rbot-surface` | Bubble backgrounds (assistant side) |
| `--rbot-border` | Dividers, input borders |
| `--rbot-error` | Error states |

### Typography

| Property | Use |
|---|---|
| `--rbot-font` | Family stack (e.g. `'Inter', system-ui, sans-serif`) |
| `--rbot-font-size` | Base size (default `15px`) |

### Shape

| Property | Use |
|---|---|
| `--rbot-radius-button` | Send button + paperclip |
| `--rbot-radius-pane` | Outer pane corner |
| `--rbot-radius-bubble` | Chat bubble corner |
| `--rbot-radius-bubble-tail` | Bubble tail (touching speaker side) |

### Shadow

| Property | Use |
|---|---|
| `--rbot-shadow-button` | Send / paperclip elevation |
| `--rbot-shadow-pane` | Pane elevation when open |
| `--rbot-shadow-bubble` | Bubble elevation |

## Editing themes

Admin console → Preview tab → Appearance:

- Color pickers for the 8 color tokens (HSL/HEX).
- Number inputs for font size, all four radii.
- Font family selector with curated Google-Fonts list + custom override.
- "Restore defaults" button.

Behind the scenes, the panel calls the copilot's `update_widget_theme` tool. The change is reflected in `widget_theme` JSON + reflected back via `/api/config` so the live widget can preview without a redeploy.

## Custom CSS

For overrides the property system can't express (e.g. tweak only the user bubble), use the Custom CSS tab. The CSS is run through `lib/css-sanitize.ts` server-side — `@import`, `expression()`, `behavior: url(...)`, and `javascript:` URLs are stripped; length is capped at 16 KB.

The widget injects the sanitized CSS into a `<style>` tag inside its shadow DOM so it can't bleed onto the host page.

## Backward-compat aliases

`--wildcare-green`, `--wildcare-navy`, `--site-primary`, `--site-secondary` are defined as aliases to the corresponding `--rbot-*` properties so legacy custom CSS keeps working.

## Embed dist build

```bash
make build-widget
```

Outputs `web/widget-dist/widget.js`. The committed file should match `web/src/widget.js` after build; CI's `verify-widget-dist` job catches drift.
