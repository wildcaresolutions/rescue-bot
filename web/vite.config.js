import { defineConfig } from 'vite'
import { resolve } from 'path'

// Note: there used to be a build-time `__SITE_CONFIG__` injection sourced from
// site/site.yaml — that path leaked WildCare-specific name/phone/url into every
// build's JS bundle (per the 2026-05-16 pre-prod audit, P0-G + section 5 on
// vestigial `site/`). The runtime `/api/config` endpoint is the canonical
// source of per-tenant config now; the fallback path in
// web/src/shared/site-config.js handles the (rare) failure case with neutral
// defaults. No `define` is needed here — `typeof __SITE_CONFIG__` evaluates
// to `'undefined'` at runtime in the absence of a substitution, which is what
// the fallback checks for.

export default defineConfig(({ command: _command, mode }) => ({
  root: '.',
  publicDir: 'public',
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: mode === 'widget' ? 'widget-dist' : 'dist',
    assetsDir: 'assets',
    cssCodeSplit: mode !== 'widget',
    rollupOptions: mode === 'widget' ? {
      input: 'src/widget.js',
      output: {
        entryFileNames: 'widget.js',
        assetFileNames: 'widget.[ext]',
      },
      codeSplitting: false,
    } : {
      input: {
        main: resolve(__dirname, 'chat.html'),
        admin: resolve(__dirname, 'admin.html'),
        demo: resolve(__dirname, 'widget-example.html'),
      },
    },
  },
}))
