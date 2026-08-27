# AGENTS.md

## Commands

- `npm run dev` starts Vite on `http://localhost:5173` and the Express API on `http://127.0.0.1:8787`; Vite proxies `/api` with a 360-second timeout.
- `npm run dev:web` and `npm run dev:api` run one side only.
- Run checks as `npm run lint`, `npm test`, then `npm run build`. The build separately type-checks the browser and `server/`, then builds Vite.
- Focus Vitest with `npx vitest run <file>` or `npx vitest run -t "<name>"`. Vitest includes `src/**/*.test.{ts,tsx}` and `server/**/*.test.ts` in jsdom.
- Playwright has no npm script. Run the mocked kiosk flow with `npx playwright test e2e/kiosk-flow.spec.ts`. Do not run `e2e/real-upload.integration.spec.ts` casually: it uploads `src/test/PixPin_2026-07-03_14-12-16.png`, waits up to 6 minutes, and calls whichever real provider `.env.local` selects.
- `npm run test:gpt-image-2 -- --input <image> --output <image> --prompt "..."` is a live provider smoke test, not a unit test.

## 已知问题记录

- `docs/issues/` 下的每份文档都是通过审查、测试或运行发现的项目问题记录。该目录是已知问题的权威台账，不是普通产品文档目录。
- 每个问题必须保留发现时间和当前状态。允许使用的状态为：`待处理`、`处理中`、`已解决`、`暂不处理`。
- 开始或完成相关工作时，必须更新原问题条目。已解决的问题必须补充解决时间、相关提交或 PR（如有）及验证证据，不得删除已解决的问题。
- 修改相关功能前应先查看对应问题记录。新确认的问题应写入该目录，不能只保留在聊天、日志或代码注释中。

## Runtime Configuration

- `server/index.ts` loads `.env.local` before `.env`. Copy `.env.example` locally; both files are ignored except the example.
- Browser generation selection is `VITE_GENERATION_MODE=mock|api`; server provider selection is independently `AI_PROVIDER=mock|gpt-image-2|seedream|jimeng-i2i`. Real-provider credentials must never use a `VITE_` prefix or enter browser code/logs.
- Check the active server provider at `/api/health`. JSON-line operational logs default to `logs/generation.log`; never add raw photos, image/base64 payloads, prompts, provider response bodies, tokens, or secrets to logs.
- `PAYMENT_MODE=mock` is the local path. Real WeChat Native payment requires HTTPS and server-side PEM/key configuration. Orders persist to `data/payment-orders.json`, which is intentionally single-instance storage.

## Development Server Lifecycle

- Vite hot module replacement only updates browser code. The `npm run dev:api` command uses `tsx server/index.ts`, not watch mode, so changes under `server/`, shared fixtures imported by the server, route validation, provider code, allowlists, or runtime configuration require an explicit API restart.
- Never tell the user a server-side change is available merely because the build/tests pass or the browser UI has hot-reloaded. Restart the API, request `GET http://127.0.0.1:8787/api/health`, and probe the changed endpoint with input that distinguishes the new behavior from the old behavior.
- After restarting one child of `npm run dev`, verify both `http://localhost:5173` and `http://127.0.0.1:8787/api/health`. `concurrently -k` can terminate the other child when either process exits, so restart any side that is no longer listening.
- When a new client-visible allowlisted value is added, such as a scene ID or style ID, verify that the running API accepts that exact value before asking the user to retry. A UI option appearing in Vite does not prove the API process loaded the matching allowlist.

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
