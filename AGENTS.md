# AGENTS.md

## Commands

- Runtime requires Node.js `>=22.12.0` and npm `>=10` (see `package.json`). `npm run server:dev` reinstalls dev dependencies with `npm ci --include=dev` before starting both services; use it only when a clean dependency install is intended.
- `npm run dev` starts Vite on `http://localhost:5173` and the Express API on `http://127.0.0.1:8787`; Vite proxies `/api` with a 360-second timeout.
- `npm run dev:web` and `npm run dev:api` run one side only.
- Run checks as `npm run lint`, `npm test`, then `npm run build`. The build separately type-checks the browser and `server/`, then builds Vite.
- Focus Vitest with `npx vitest run <file>` or `npx vitest run -t "<name>"`. Vitest includes `src/**/*.test.{ts,tsx}` and `server/**/*.test.ts` in jsdom.
- Playwright has no npm script. Run the mocked kiosk flow with `npx playwright test e2e/kiosk-flow.spec.ts`; it covers both classic and Agent paths. Do not run `e2e/real-upload.integration.spec.ts` casually: it uploads `src/test/PixPin_2026-07-03_14-12-16.png`, waits up to 6 minutes, and calls whichever real provider `.env.local` selects.
- `npm run test:gpt-image-2 -- --input <image> --output <image> --prompt "..."` is a live provider smoke test, not a unit test.

## 已知问题记录

- `docs/issues/` 下的每份文档都是通过审查、测试或运行发现的项目问题记录。该目录是已知问题的权威台账，不是普通产品文档目录。
- 每个问题必须保留发现时间和当前状态。允许使用的状态为：`待处理`、`处理中`、`已解决`、`暂不处理`。
- 开始或完成相关工作时，必须更新原问题条目。已解决的问题必须补充解决时间、相关提交或 PR（如有）及验证证据，不得删除已解决的问题。
- 修改相关功能前应先查看对应问题记录。新确认的问题应写入该目录，不能只保留在聊天、日志或代码注释中。

## Runtime Configuration

- `server/index.ts` loads `.env.local` before `.env`. Copy `.env.example` locally; both files are ignored except the example.
- Browser generation selection is `VITE_GENERATION_MODE=mock|api`; server provider selection is independently `AI_PROVIDER=mock|gpt-image-2|seedream|jimeng-i2i|gemini-3.1-flash-image`. Real-provider credentials must never use a `VITE_` prefix or enter browser code/logs.
- Agent mode is exposed by `POST /api/agent/generation`. The visitor route is enabled for the Gemini image provider when the server has valid Gemini image settings and at least one administrator-published, pre-analyzed background; it does not call the vision model per visitor request. `runtime.agentEnabled` and the published `backgrounds` are returned by `GET /api/catalog`.
- `VISION_BASE_URL`, `VISION_API_KEY`, `VISION_MODEL`, `VISION_ENDPOINT`, and `VISION_REQUEST_TIMEOUT_MS` configure the administrator-only background analysis call. The browser submits only `backgroundId`; the server reads the saved analysis and finalizes the prompt, so never add client-supplied prompt text to the Agent request contract.
- Check the active server provider at `/api/health`. JSON-line operational logs default to `logs/generation.log`; never add raw photos, image/base64 payloads, prompts, provider response bodies, tokens, or secrets to logs.
- `PAYMENT_MODE=mock` is the local path. Real WeChat Native payment requires HTTPS and server-side PEM/key configuration. Orders persist to `data/payment-orders.json`, which is intentionally single-instance storage.

## Development Server Lifecycle

- Vite hot module replacement only updates browser code. The `npm run dev:api` command uses `tsx server/index.ts`, not watch mode, so changes under `server/`, shared fixtures imported by the server, route validation, provider code, allowlists, or runtime configuration require an explicit API restart.
- Never tell the user a server-side change is available merely because the build/tests pass or the browser UI has hot-reloaded. Restart the API, request `GET http://127.0.0.1:8787/api/health`, and probe the changed endpoint with input that distinguishes the new behavior from the old behavior.
- After restarting one child of `npm run dev`, verify both `http://localhost:5173` and `http://127.0.0.1:8787/api/health`. `concurrently -k` can terminate the other child when either process exits, so restart any side that is no longer listening.
- When a new client-visible allowlisted value is added, such as a scene ID or style ID, verify that the running API accepts that exact value before asking the user to retry. A UI option appearing in Vite does not prove the API process loaded the matching allowlist.

## Architecture Boundaries

- `src/features/kiosk/KioskFlow.tsx` owns screens and orchestration, but session transitions/data belong in `src/features/session/sessionReducer.ts`; avoid parallel page-local session state.
- UI accesses integrations through `src/services/index.ts` and contracts in `src/services/contracts.ts`. Provider-specific request logic belongs only in `server/providers/`, selected by `server/config.ts`; do not branch on providers in the kiosk UI or reducer. Agent calls use `src/services/httpAgentGeneration.ts` or the mock service and the `AgentGenerationService` contract.
- `/api/generation` requires `X-Payment-Token`, validates it against the session, accepts only style IDs, resolves prompts from `src/mocks/fixtures/styles.ts`, and processes selected styles through the server provider semaphore. Keep prompt allowlisting server-controlled.
- `/api/agent/generation` requires `X-Payment-Token`, a UUID `generationId`, a photo, and an allowlisted `backgroundId`. It consumes the same single-payment generation entitlement and is idempotent by session/photo/background/generation ID. Agent currently supports only `mock` and `gemini-3.1-flash-image`; unsupported providers must return `CONFIG_ERROR`.
- Agent prompt analysis and image composition happen inside one paid request. `server/vision/analyze.ts` sanitizes and bounds model output, then appends server-controlled identity, scene-fusion, and quality constraints. Keep the prompt in the response/memory only; do not persist or log it.
- The current product maximum is 4 classic styles (`src/config/product.ts`), despite stale prose elsewhere saying two. The server currently serializes provider work with a single-slot semaphore; do not describe or depend on two-way concurrency unless the implementation and tests change together. Keep browser limits, API validation, and tests aligned when changing the maximum.
- Agent backgrounds are administrator-managed, versioned MySQL records with assets stored by `AssetStore` under the `background` category. Only published records with `analysis_status=ready` appear in the visitor catalog. `src/mocks/fixtures/backgrounds.ts` is test-only; do not use it as a production/API fallback. Real Gemini composition accepts only JPEG, PNG, or WebP background assets.
- Start generation from the user action, not a mount effect: React StrictMode can otherwise submit paid provider requests twice.
- Camera permission/device failures must retain the sample-image fallback. The QR/share service is still a demo URL; a data URL is not a cross-device share mechanism.

## Generated And Sensitive Files

- Do not commit `.env.local`, `secrets/`, `data/`, `logs/`, `test/output/`, `dist/`, or `dist-server/`. `dist-server/` is emitted by the server TypeScript build even though it is not listed in `.gitignore`.
- `npm run start` runs `dist-server/server/index.js` and serves `dist/` plus the API, so run `npm run build` first.

## Agent Mode Verification

- Before calling Agent mode available, restart the API after server/config/provider changes, verify both `http://localhost:5173` and `GET http://127.0.0.1:8787/api/health`, then verify `GET /api/catalog` reports the expected `runtime.agentEnabled` and background IDs.
- Offline validation must include the Agent vision/prompt tests, Agent generation route tests (payment, background allowlist, idempotency, and error paths), `npm run lint`, `npm test`, `npm run build`, and the Agent case in `npx playwright test e2e/kiosk-flow.spec.ts`.
- Real background analysis requires valid server-only `VISION_*` settings; real Agent generation requires valid Gemini image settings plus at least one published, analyzed raster background. Record real-provider findings in `docs/issues/`; do not place credentials, photos, prompts, or upstream response bodies in logs or issue files.
