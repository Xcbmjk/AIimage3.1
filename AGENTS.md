# AGENTS.md

## Commands

- `npm run dev` starts Vite on `http://localhost:5173` and the Express API on `http://127.0.0.1:8787`; Vite proxies `/api` with a 360-second timeout.
- `npm run dev:web` and `npm run dev:api` run one side only.
- Run checks as `npm run lint`, `npm test`, then `npm run build`. The build separately type-checks the browser and `server/`, then builds Vite.
- Focus Vitest with `npx vitest run <file>` or `npx vitest run -t "<name>"`. Vitest includes `src/**/*.test.{ts,tsx}` and `server/**/*.test.ts` in jsdom.
- Playwright has no npm script. Run the mocked kiosk flow with `npx playwright test e2e/kiosk-flow.spec.ts`. Do not run `e2e/real-upload.integration.spec.ts` casually: it uploads `src/test/PixPin_2026-07-03_14-12-16.png`, waits up to 6 minutes, and calls whichever real provider `.env.local` selects.
- `npm run test:gpt-image-2 -- --input <image> --output <image> --prompt "..."` is a live provider smoke test, not a unit test.

## Runtime Configuration

- `server/index.ts` loads `.env.local` before `.env`. Copy `.env.example` locally; both files are ignored except the example.
- Browser generation selection is `VITE_GENERATION_MODE=mock|api`; server provider selection is independently `AI_PROVIDER=mock|gpt-image-2|seedream|jimeng-i2i`. Real-provider credentials must never use a `VITE_` prefix or enter browser code/logs.
- Check the active server provider at `/api/health`. JSON-line operational logs default to `logs/generation.log`; never add raw photos, image/base64 payloads, prompts, provider response bodies, tokens, or secrets to logs.
- `PAYMENT_MODE=mock` is the local path. Real WeChat Native payment requires HTTPS and server-side PEM/key configuration. Orders persist to `data/payment-orders.json`, which is intentionally single-instance storage.

## Architecture Boundaries

- `src/features/kiosk/KioskFlow.tsx` owns screens and orchestration, but session transitions/data belong in `src/features/session/sessionReducer.ts`; avoid parallel page-local session state.
- UI accesses integrations through `src/services/index.ts` and contracts in `src/services/contracts.ts`. Provider-specific request logic belongs only in `server/providers/`, selected by `server/config.ts`; do not branch on providers in the kiosk UI or reducer.
- `/api/generation` requires `X-Payment-Token`, validates it against the session, accepts only style IDs, resolves prompts from `src/mocks/fixtures/styles.ts`, and generates at most two styles concurrently. Keep prompt allowlisting server-controlled.
- The current product maximum is 4 styles (`src/config/product.ts`), despite stale prose elsewhere saying two. Keep browser limits, API validation, and tests aligned when changing it.
- Start generation from the user action, not a mount effect: React StrictMode can otherwise submit paid provider requests twice.
- Camera permission/device failures must retain the sample-image fallback. The QR/share service is still a demo URL; a data URL is not a cross-device share mechanism.

## Generated And Sensitive Files

- Do not commit `.env.local`, `secrets/`, `data/`, `logs/`, `test/output/`, `dist/`, or `dist-server/`. `dist-server/` is emitted by the server TypeScript build even though it is not listed in `.gitignore`.
- `npm run start` runs `dist-server/server/index.js` and serves `dist/` plus the API, so run `npm run build` first.
