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

Run the web app and local AI API together:

```bash
npm run dev
```

This starts Vite on `http://localhost:5173` and the Node API on `http://127.0.0.1:8787`. Vite proxies `/api` to the API server.

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

`npm run build` type-checks/builds both the browser app and `server/`. `npm run start` runs the compiled Node server, which serves `dist` as well as the API when the build exists.

## Configuration

Copy `.env.example` to `.env.local` for local provider configuration. `.env.local` is ignored by git.

The browser-side switch is:

```dotenv
VITE_GENERATION_MODE=mock
```

Use `mock` for offline demos. Use `api` to call the local Node proxy.

The server-side provider switch is:

```dotenv
AI_PROVIDER=mock
```

Supported values are `mock`, `gpt-image-2`, and `seedream`.

For GPT Image 2-compatible services, configure `GPT_IMAGE_BASE_URL`, `GPT_IMAGE_API_KEY`, `GPT_IMAGE_MODEL`, and optionally endpoint/size/response format. For Volcengine Ark Seedream, configure `ARK_API_KEY` and `ARK_SEEDREAM_MODEL` (the Ark inference endpoint/model ID), plus the optional Ark base URL, endpoint, size, response format, and watermark settings. Never use `VITE_` variables for provider secrets.

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
- `VITE_GENERATION_MODE` chooses mock vs HTTP generation in the browser. `AI_PROVIDER` is deliberately server-only and must not be exposed in the bundle.

### Node generation API

`server/index.ts` creates the Express server, loads `.env` configuration, exposes `/api/health`, mounts the generation route, and serves the built frontend in production.

- `server/config.ts` validates provider-specific environment variables and keeps provider configuration server-side.
- `server/routes/generation.ts` validates session/photo/style input, decodes the data URL, looks up allowed style prompts from the shared fixture catalog, invokes the configured provider, and returns normalized assets.
- `server/providers/types.ts` defines the adapter boundary.
- `server/providers/mock.ts` returns local fixture images.
- `server/providers/gptImage2.ts` sends multipart OpenAI Images API-compatible requests and accepts base64 or URL responses.
- `server/providers/seedream.ts` sends JSON requests to the Ark endpoint and accepts common `data`/`images` base64 or URL response shapes.
- `server/lib/images.ts` validates/decodes image data URLs, normalizes base64 responses, and safely downloads HTTPS image URLs returned by providers.
- `server/lib/errors.ts` maps upstream statuses/timeouts to stable, non-sensitive API error responses.

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