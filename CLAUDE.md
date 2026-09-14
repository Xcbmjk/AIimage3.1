# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Project overview

`shan-jing-ai-kiosk` is a React + TypeScript + Vite demo for a 1080×1920 portrait scenic-area kiosk. The visitor flow is intentionally kiosk-only: redeem a one-time experience code, take a photo with the kiosk camera (or fall back to a local demo image), choose up to two styles, generate images, inspect the results, and scan a QR code to save them. There is no mobile-upload flow or admin backend.

The project supports both offline demo generation and server-proxied real providers. Keep provider credentials server-side; browser code must only call the same-origin `/api` endpoints.

## Commands

Install dependencies:

```bash
npm install
```

Run the web app and local Python API together:

```bash
npm run dev
```

This starts Vite on `http://localhost:5173` and the Python API on `http://127.0.0.1:8787`. Vite proxies `/api` to the API server.

Run only one side:

```bash
npm run dev:web
npm run dev:api
```

Quality checks:

```bash
npm run lint
npm test
npm run build
```

Run one test file or one test name:

```bash
npx vitest run src/features/session/sessionReducer.test.ts
npx vitest run -t "enforces the maximum style count"
```

Production build and start:

```bash
npm run build
npm run start
```

`npm run build` type-checks and builds the browser app. `npm run start` starts the Python/FastAPI runtime; when `STATIC_DIRECTORY=dist`, it serves `dist` and the API.

## Configuration

Copy `.env.example` to `.env.local` for local provider configuration. `.env.local` is ignored by git.

The browser-side switch is:

```dotenv
VITE_GENERATION_MODE=mock
```

Use `mock` for offline demos. Use `api` to call the local Python API.

The server-side provider is chosen in the database, not in `.env`:

```
model_configs (image_generation)  →  the default row decides the vendor
```

Add a row through the admin console (base URL, endpoints, model, API key) and mark it default. Other enabled rows act as standby lines and take over when the default line fails. `model_configs.provider` is a free-form vendor label; it only selects an implementation when it matches `SELECTABLE_PROVIDER_KEYS` (`mock`, `gpt-image-2`) — the product currently targets `gpt-image-2` alone, so the other shipped implementations degrade to it rather than switching protocols. Every other label is treated as OpenAI-compatible. Only `app_env="test"` with no row falls back to the mock provider.

Per-vendor resilience is stored per row rather than in the environment: `timeout_ms`, `max_attempts`, `failure_threshold` and `cooldown_seconds`. `failure_threshold` defaults to 1 because each style contributes only one line failure per request.

The `GPT_IMAGE_*`, `ARK_*`, `VOLC_*`, `JIMENG_*`, and `GEMINI_IMAGE_*` settings remain only as fallbacks for providers that cannot be described by an OpenAI-compatible row. Never use `VITE_` variables for provider secrets.

The API health endpoint is:

```text
http://127.0.0.1:8787/api/health
```

## Architecture

### Browser application

- `src/main.tsx` mounts the app and global styles.
- `src/app/App.tsx` wraps the kiosk flow in `SessionProvider`.
- `src/features/kiosk/KioskFlow.tsx` contains the complete visitor state flow and visual screens: welcome, redeem, camera, photo review, style selection, generation, results, and download/QR.
- `src/features/session/SessionProvider.tsx` exposes session state; `src/features/session/sessionReducer.ts` is the single state transition point. Add new stage transitions and session data changes to the reducer rather than managing parallel page-local state.
- `src/types/index.ts` contains the shared domain types: kiosk session, entitlement, captured photo, styles, jobs, assets, share links, provider names, and API error models.
- `src/config/brand.ts` holds replaceable scenic-area branding/copy. `src/config/product.ts` holds demo limits such as the maximum style count and demo code.
- `src/styles/tokens.css` and `src/styles/global.css` define the visual system. The intended direction is dark mountain green, rice-paper beige, cinnabar, and muted gold with Chinese display/body typography.

### Service boundary

UI code depends on the service object exported by `src/services/index.ts`, not directly on providers. The existing contracts in `src/services/contracts.ts` define entitlement, camera, generation, share, and style services.

- `src/mocks/services/` contains offline camera, entitlement, generation, share, and style implementations.
- `src/services/httpGeneration.ts` is the browser implementation for real generation. It sends the photo and selected style IDs to `/api/generation`, reports bounded perceived progress while synchronous provider requests are pending, and maps timeout/failure into user-visible errors.
- `VITE_GENERATION_MODE` chooses mock vs HTTP generation in the browser. The server provider is deliberately server-only, resolved from the database, and must not be exposed in the bundle.

### Python generation API

`backend/app/main.py` creates the FastAPI application, loads runtime configuration,
mounts visitor/admin routes, runs maintenance, and serves the built frontend.

- `backend/app/config.py` validates provider-specific environment variables and keeps provider configuration server-side.
- `backend/app/api/generation.py` validates multipart session/photo/style input and delegates generation to the domain service.
- `backend/app/providers/` defines the provider adapter boundary and provider implementations.
- `backend/app/storage/images.py` validates real image formats, dimensions, and byte limits.
- `backend/app/providers/images.py` normalizes provider images and safely downloads HTTPS image URLs.
- `backend/app/api/errors.py` maps failures to stable, non-sensitive API responses.

Provider-specific request differences belong in their adapter. Do not add provider branching to `KioskFlow` or the reducer.

### Styles and prompts

`src/mocks/fixtures/styles.ts` is currently the shared style catalog and contains both display metadata and provider-neutral prompts. The server accepts style IDs rather than arbitrary browser-provided prompts, then resolves the allowlisted prompt from this catalog. If the catalog grows or needs to be shared without importing fixture imagery into server code, extract a provider-neutral catalog module rather than duplicating prompt strings.

### Tests and tooling

Vitest runs in jsdom using `src/test/setup.ts`. Existing reducer tests are colocated at `src/features/session/sessionReducer.test.ts`. Vite config includes the test environment and `/api` development proxy. ESLint covers TypeScript/TSX and React hooks.

## Important behavior boundaries

- The demo experience code is one-time use and persisted in browser localStorage only for demonstration. Production redemption must be server-side and atomic.
- Camera access is attempted through `getUserMedia`; permission/device failure must preserve the demo fallback path.
- The QR code currently represents a demo share URL. Real cross-device saving requires a public HTTPS result page and object storage; a browser data URL is not a cross-device share mechanism.
- Provider image APIs generally do not expose a true progress percentage. The generation screen's progress is bounded waiting feedback, not an upstream progress claim.
- Do not log API keys, raw visitor photos, provider response bodies, or generated image payloads. The API should log only safe metadata if operational logging is added.
#使用中文回答问题
