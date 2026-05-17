<!--
  This file is intentionally generic.

  Per-tenant content (organization-specific protocols, contact info, redirect
  rules, species restrictions) lives in the `tenants` table — in the
  `org_config` JSON column (structured fields like species_config, hours,
  after_hours_phone) and the `house_rules` text column (operator-pinned
  prose that appends to the compiled prompt verbatim).

  This file used to contain a single tenant's org-specific instruction
  baked into every Worker deployment via
  `workers/scripts/gen-instructions.js`. A migration moved that content
  into the per-tenant `house_rules` row in the `tenants` table, where it
  belongs — operator-owned, per-tenant, editable via the admin UI.

  KEEP THIS FILE GENERIC. Anything org-specific you put here will leak
  into every tenant's bot prompt. If you need a multi-tenant deployment
  to share global guidance (e.g., a default rescue tone or universal
  safety constraints), that's fine — but never name specific organizations
  or phone numbers here.
-->
