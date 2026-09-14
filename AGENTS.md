# AGENTS.md

## Commands

- Runtime requires Node.js `>=22.12.0` and npm `>=10` (see `package.json`). `npm run server:dev` reinstalls dev dependencies with `npm ci --include=dev` before starting Vite and the Python API; use it only when a clean dependency install is intended.
- `npm run dev` starts Vite on `http://localhost:5173` and the Python API on `http://127.0.0.1:8787`; Vite proxies `/api` with a 360-second timeout.
- `npm run dev:web` and `npm run dev:api` run one side only.
- Run checks as `npm run lint`, `npm test`, then `npm run build`. The build type-checks the browser and builds Vite; Python checks use `python -m pytest backend/tests`.
- Focus Vitest with `npx vitest run <file>` or `npx vitest run -t "<name>"`. Vitest includes `src/**/*.test.{ts,tsx}` in jsdom.
- Playwright has no npm script. Run the mocked kiosk flow with `npx playwright test e2e/kiosk-flow.spec.ts`; it covers both classic and Agent paths. Do not run `e2e/real-upload.integration.spec.ts` casually: it uploads `src/test/PixPin_2026-07-03_14-12-16.png`, waits up to 6 minutes, and calls whichever real provider `.env.local` selects.
- `npm run test:gpt-image-2 -- --input <image> --output <image> --prompt "..."` is a live provider smoke test, not a unit test.
- 每次修改代码后都必须运行与改动范围匹配的测试；测试通过后自动创建一次 Git 提交。提交信息必须简要说明改动内容和验证结果，禁止在测试未通过时提交代码。
- Android APK 构建：先执行 `npm run android:sync`，再在安装 Android Studio、JDK 和 Android SDK 的环境执行 `npm run android:build`；`VITE_API_BASE_URL` 可以放在唯一的 `.env.local` 中，只有原生 Android WebView 使用它访问公网 HTTP API，普通浏览器开发和服务器托管页面始终使用同源 `/api`。

## 已知问题记录

- `docs/issues/` 下的每份文档都是通过审查、测试或运行发现的项目问题记录。该目录是已知问题的权威台账，不是普通产品文档目录。
- 每个问题必须保留发现时间和当前状态。允许使用的状态为：`待处理`、`处理中`、`已解决`、`暂不处理`。
- 开始或完成相关工作时，必须更新原问题条目。已解决的问题必须补充解决时间、相关提交或 PR（如有）及验证证据，不得删除已解决的问题。
- 修改相关功能前应先查看对应问题记录。新确认的问题应写入该目录，不能只保留在聊天、日志或代码注释中。

## Runtime Configuration

- `backend/app/config.py` loads `.env.local` before `.env`. Copy `.env.example` locally; both files are ignored except the example.
- 本项目部署约束：项目最终运行在单台安卓设备上，前端应封装在 Android APK/WebView 内，调用该安卓设备当前系统摄像头；Python/FastAPI 后端运行在可通过公网访问的独立服务器上。项目当前不使用 HTTPS，也不得在后续方案中把 HTTPS 作为前置条件或推荐方案。安卓端通过 HTTP 访问服务器 API，并在 Android 应用中显式允许摄像头权限和明文网络访问（`CAMERA`、`INTERNET`、`usesCleartextTraffic=true`）。
- 安卓封装方案不得改为调用服务器摄像头；照片由安卓设备拍摄后通过 HTTP 上传到公网服务器。可以使用公网域名或公网 IP，不要求内网穿透。网页端 `getUserMedia` 的示例回退仍需保留，方便桌面浏览器调试。
- Browser generation selection is `VITE_GENERATION_MODE=mock|api`. Server provider selection lives in the database and there is deliberately no environment override: `model_configs` rows for `image_generation` decide the vendor, the default row leads, and other enabled rows are standby lines behind a circuit breaker. `model_configs.provider` is a free-form vendor label that selects a shipped implementation only when it matches one (`mock`, `gpt-image-2`, `gpt-image-2-url`, `seedream`, `jimeng-i2i`, `gemini-3.1-flash-image`); any other label is treated as OpenAI-compatible. Only `app_env="test"` may fall back to the mock provider when no row exists. Real-provider credentials must never use a `VITE_` prefix or enter browser code/logs.
- Agent mode is exposed by `POST /api/agent/generation`. The visitor route is enabled when a default `vision_analysis` row and a default `image_generation` row both exist and at least one administrator-published, pre-analyzed background is available; it does not call the vision model per visitor request. `runtime.agentEnabled` and the published `backgrounds` are returned by `GET /api/catalog`.
- `VISION_BASE_URL`, `VISION_API_KEY`, `VISION_MODEL`, `VISION_ENDPOINT`, and `VISION_REQUEST_TIMEOUT_MS` are legacy fallbacks only; the administrator-only background analysis reads the default `vision_analysis` row instead. The browser submits only `backgroundId`; the server reads the saved analysis and finalizes the prompt, so never add client-supplied prompt text to the Agent request contract.
- Check the active server provider at `/api/health` (`imageGeneration.details.implementation` and `standbyLines`). JSON-line operational logs default to `logs/generation.log`; never add raw photos, image/base64 payloads, prompts, provider response bodies, tokens, or secrets to logs.
- Payment, order, refund, pricing, and external mini-program redeem-claim features are removed from the Python runtime. Redeem codes are generated only by the administrator endpoints.

## Development Server Lifecycle

- Vite hot module replacement only updates browser code. The Python API runs with `uvicorn backend.app.main:app`; changes under `backend/`, migrations, route validation, provider code, allowlists, or runtime configuration require an explicit API restart.
- Never tell the user a server-side change is available merely because the build/tests pass or the browser UI has hot-reloaded. Restart the Python API, request `GET http://127.0.0.1:8787/api/health`, and probe the changed endpoint with input that distinguishes the new behavior from the old behavior.
- After restarting one child of `npm run dev`, verify both `http://localhost:5173` and `http://127.0.0.1:8787/api/health`. `concurrently -k` can terminate the other child when either process exits, so restart any side that is no longer listening.
- When a new client-visible allowlisted value is added, such as a scene ID or style ID, verify that the running API accepts that exact value before asking the user to retry. A UI option appearing in Vite does not prove the API process loaded the matching allowlist.

## Architecture Boundaries

- `src/features/kiosk/KioskFlow.tsx` owns screens and orchestration, but session transitions/data belong in `src/features/session/sessionReducer.ts`; avoid parallel page-local session state.
- UI accesses integrations through `src/services/index.ts` and contracts in `src/services/contracts.ts`. Provider-specific request logic belongs only in `backend/app/providers/`, selected by `backend/app/providers/factory.py`; do not branch on providers in the kiosk UI or reducer. Agent calls use `src/services/httpAgentGeneration.ts` or the mock service and the `AgentGenerationService` contract.
- `/api/generation` requires `X-Entitlement-Token`, validates it against the session, accepts only style IDs, resolves prompts from the server catalog, and processes selected styles through the Python provider boundary. Keep prompt allowlisting server-controlled.
- `/api/agent/generation` requires `X-Entitlement-Token`, a UUID `generationId`, a photo, and an allowlisted `backgroundId`. It consumes the same single-entitlement generation allowance and is idempotent by session/photo/background/generation ID. Agent currently supports only `mock` and `gemini-3.1-flash-image`; unsupported providers must return `CONFIG_ERROR`.
- Agent prompt analysis and image composition happen inside one entitlement-backed request. `backend/app/vision/analyze.py` sanitizes and bounds model output, then appends server-controlled identity, scene-fusion, and quality constraints. Keep the prompt in the response/memory only; do not persist or log it.
- The current product maximum is 4 classic styles (`src/config/product.ts`), despite stale prose elsewhere saying two. The server currently serializes provider work with a single-slot semaphore; do not describe or depend on two-way concurrency unless the implementation and tests change together. Keep browser limits, API validation, and tests aligned when changing the maximum.
- Agent backgrounds are administrator-managed, versioned MySQL records with assets stored by `AssetStore` under the `background` category. Only published records with `analysis_status=ready` appear in the visitor catalog. `src/mocks/fixtures/backgrounds.ts` is test-only; do not use it as a production/API fallback. Real Gemini composition accepts only JPEG, PNG, or WebP background assets.
- Start generation from the user action, not a mount effect: React StrictMode can otherwise submit provider requests twice.
- Camera permission/device failures must retain the sample-image fallback. Share requests must reference server-persisted asset IDs; a client data URL is not accepted.

## Generated And Sensitive Files

- Do not commit `.env.local`, `secrets/`, `data/`, `logs/`, `test/output/`, or `dist/`.
- The Python runtime serves `dist/` plus the API when `STATIC_DIRECTORY=dist`; the legacy Node server is not the migration runtime.

## Agent Mode Verification

- Before calling Agent mode available, restart the Python API after backend/config/provider changes, verify both `http://localhost:5173` and `GET http://127.0.0.1:8787/api/health`, then verify `GET /api/catalog` reports the expected `runtime.agentEnabled` and background IDs.
- Offline validation must include the Python Agent vision/prompt tests, Agent generation route tests (entitlement, background allowlist, idempotency, and error paths), `python -m pytest backend/tests`, `npm run lint`, `npm test`, `npm run build`, and the Agent case in `npx playwright test e2e/kiosk-flow.spec.ts`.
- Real background analysis requires valid server-only `VISION_*` settings; real Agent generation requires valid Gemini image settings plus at least one published, analyzed raster background. Record real-provider findings in `docs/issues/`; do not place credentials, photos, prompts, or upstream response bodies in logs or issue files.
