# WildCare Chat Web Interface

A user-friendly web interface for the WildCare wildlife rescue assistant.

## Features

- 🔐 Password-protected access for internal testing
- 💬 Real-time streaming chat interface
- 📱 Responsive design (works on mobile and desktop)
- 📝 Markdown rendering for formatted instructions
- 💾 Session persistence (resumes conversations)
- 🎨 WildCare-branded design

## Development

### Prerequisites

- Node.js 18+ installed
- cagent server running on port 8080

### Setup

```bash
cd web
npm install
```

### Run Development Server

```bash
npm run dev
```

This will start the Vite dev server on http://localhost:3000 and proxy API requests to the cagent server on port 8080.

### Build for Production

```bash
npm run build
```

This creates a `dist/` folder with optimized static files ready to deploy.

## Authentication

The default password is `wildcare2025`. To change it, edit `src/auth.js`.

For production, you should:
1. Use environment variables for the password
2. Implement proper backend authentication
3. Use HTTPS

## Session Export for Evals

To export all chat sessions for evaluation:

```bash
node export-sessions.js [output-file.json]
```

This will:
- Fetch all sessions from the cagent API
- Include full message history
- Output JSON with timestamps and token usage stats

Example output structure:
```json
{
  "exported_at": "2024-01-15T10:30:00.000Z",
  "total_sessions": 42,
  "sessions": [
    {
      "id": "session-123",
      "messages": [...],
      "input_tokens": 1500,
      "output_tokens": 2300,
      ...
    }
  ]
}
```

## Deployment

### Option 1: Static Hosting + Separate API

Build the app and deploy static files to:
- Vercel
- Netlify
- GitHub Pages
- Cloud Run (static)

Configure API proxy or CORS on your cagent server.

### Option 2: Docker Container

Create a Dockerfile that:
1. Builds the Vite app
2. Runs cagent server
3. Serves static files with nginx or similar
4. Proxies `/api` to cagent

Example Dockerfile structure:
```dockerfile
FROM node:18 AS builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM debian:bookworm-slim
# Copy cagent binary
COPY bin/cagent /usr/local/bin/
# Copy web build
COPY --from=builder /app/web/dist /var/www/html
# Setup nginx or similar to serve static + proxy API
```

### Option 3: Cloud Run

Deploy as a container to Google Cloud Run:
```bash
gcloud run deploy wildcare-chat \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

## Configuration

### API Endpoint

In development, Vite proxies `/api` to `http://localhost:8080/api`.

In production, configure your reverse proxy or update `src/api.js` to use the correct API base URL.

### Password

Default: `wildcare2025`

To change, edit `src/auth.js` or use environment variables.

## Browser Support

- Chrome/Edge: Latest 2 versions
- Firefox: Latest 2 versions
- Safari: Latest 2 versions
- Mobile: iOS Safari 14+, Chrome Android

## Tech Stack

- **Vite**: Build tool and dev server
- **Vanilla JavaScript**: No framework overhead
- **Marked.js**: Markdown rendering
- **CSS3**: Custom styling with WildCare branding
- **Server-Sent Events (SSE)**: Real-time streaming

## WildCare Brand Colors

- Primary Green: `#78a12e`
- Navy: `#004863`
- Orange Accent: `#f4a518`
