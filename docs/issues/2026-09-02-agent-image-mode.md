# 2026-09-02 Agent 智能生图模式（能力上线记录）

## 文档信息

- 发现/立项时间：`2026-09-02 11:30:00 +08:00`
- 最后更新时间：`2026-09-02 15:36:00 +08:00`
- 范围：在生图入口新增“选择创作方式”步骤，加入 Agent 智能生图模式（视觉模型分析背景动作 → 实时生成融合提示词 → 图像模型合成单张作品）
- 关联问题：ISSUE-023（人物与景点可控融合）、ISSUE-025（真实供应商可用性）

## 状态定义

见 `2026-08-19-project-review.md`。允许状态：`待处理`、`处理中`、`已解决`、`暂不处理`。

## 问题索引

| 编号 | 优先级 | 状态 | 问题摘要 |
| --- | --- | --- | --- |
| ISSUE-026 | P1 | 处理中 | Agent 智能生图模式已实现并通过 mock/离线验证，真实视觉+Gemini 合成待联调 |

## 问题详情

### ISSUE-026：Agent 智能生图模式

- 优先级：`P1`
- 状态：`处理中`
- 发现时间：`2026-09-02 11:30:00 +08:00`
- 开始处理时间：`2026-09-02 11:30:00 +08:00`
- 需求：在生图入口再增加一个入口。用户在确认照片后进入“选择创作方式”屏，可选择“经典风格”（沿用现有 ≤4 张流程）或“Agent 智能生图”。Agent 模式下用户仍先拍照（测试版仍可上传），随后从多张“含人物动作”的背景中挑选一张，服务端先调用视觉模型分析背景动作与照片、实时生成融合提示词，再把背景图与人物照片一并交给图像模型合成单张作品，并在结果页提供动态提示词调试预览。
- 设计决策（与产品确认）：
  1. 分析→生图→返回提示词合并为一次调用、一次付费消费（沿用 ISSUE-002 的单订单单生图幂等）。
  2. 测试版仅支持 `mock` 与 `gemini-3.1-flash-image` 作为合成图像模型；其余 provider 调用 Agent 端点返回 `CONFIG_ERROR`。
  3. 视觉模型使用独立配置 `VISION_*`，与图像生成供应商解耦。
  4. 结果页展示“查看本次动态生成的提示词”调试块；提示词仅存在于响应体与内存，不写日志。
  5. 背景由管理员后台上传、视觉理解并发布；游客只选择已发布背景，游客生图不重复调用视觉模型。
- 实现范围：
  - 客户端：`src/types/index.ts`（`mode`/`backgrounds` 阶段、`generationMode`/`selectedBackgroundId`/`agentPrompt`、`BackgroundPreset`、Agent 请求/响应类型）、`src/features/session/sessionReducer.ts`（`SELECT_MODE`/`SELECT_BACKGROUND`/`AGENT_GENERATED`）、`src/features/kiosk/KioskFlow.tsx`（`ModePage`/`AgentBackgroundsPage`、`GeneratingPage`/`ResultsPage` agent 分支、结果页提示词 `<details>`）、`src/mocks/fixtures/backgrounds.ts`、`src/services/{contracts,index,httpCatalog,httpAgentGeneration}.ts`、`src/mocks/services/generation.ts`（mock agent + mock backgrounds）、`src/services/clientLogger.ts`（`agent.*` 事件）、`src/styles/global.css`。
  - 服务端：`server/config.ts`（`vision` 块、`agentGenerationEnabled`、`VISION_*` 校验）、`server/vision/analyze.ts`（`analyzeAgentPrompt`/`composeFallbackPrompt`/`finalizeAgentPrompt`，含身份/融合/质量守卫）、`server/providers/types.ts`（可选 `compose`）、`server/providers/{mock,geminiImageEdit}.ts`（双图合成）、`server/routes/generation.ts`（`POST /api/agent/generation`，复用支付幂等与并发信号量、backgroundId 服务端白名单、`requestHash=sessionId+photo+'agent'+backgroundId`）、`server/routes/catalog.ts`（下发 `backgrounds` 与 `runtime.agentEnabled`）、`server/index.ts`（Agent 端点限流）。
  - 配置：`.env.example` 新增 `VISION_*`。
- 安全与边界：
  - 客户端只提交 `backgroundId`，不提交提示词；动态提示词由服务端视觉模型或回退逻辑生成，身份/融合/质量约束由服务端拼接，保持“提示词服务端可控”。
  - Agent 结果沿用分享/资产落盘路径：`mock` 背景为 SVG 预览，`persistAsset` 对 SVG 解码失败时按原样返回，与经典 mock 行为一致。
  - 沿用单实例内存态 `runningAgentGenerations`/`completedGenerations`；生产多实例一致性仍依赖 ISSUE-004。
- 验证证据（离线）：`npm run lint` 通过；`npm test` 的 11 个文件、42 个测试全部通过（新增 sessionReducer、`server/vision/analyze.test.ts`、`geminiImageEdit` compose、`generation.test.ts` agent 端点幂等/白名单/402/409）；`npm run build` 通过；`npx playwright test e2e/kiosk-flow.spec.ts` 的 5 个 mock 流程全部通过，含新增 Agent 单图 + 提示词预览用例。
- 待办（保持处理中的原因）：
  1. 真实联调需 `.env.local` 提供 `VISION_API_KEY`/`VISION_BASE_URL`/`VISION_MODEL` 且 `AI_PROVIDER=gemini-3.1-flash-image`，核对动作复刻与人景融合质量。
  2. 真实供应商要求背景为栅格图（JPEG/PNG/WebP）；当前 `src/mocks/fixtures/backgrounds.ts` 为 SVG 占位，正式素材需经后台或资源目录替换，否则 gemini compose 返回 `INVALID_INPUT`。
  3. Agent 模式单张结果、无风格数量；是否需要多结果或多次重试策略待产品确认。
  4. Agent 失败后的前端重试会回到背景选择，但沿用同一个 `generationId`；如果用户改选背景，服务端按一次支付一次任务幂等策略返回 `GENERATION_REQUEST_MISMATCH`，现场需要明确“不可换背景重试”或设计新的付费/任务策略。
  5. `runningAgentGenerations`、`completedGenerations` 与支付占用仍有进程内竞态/短期内存态边界：同一 `generationId` 的并发请求可能重复执行结果持久化，服务重启或多实例无法恢复结果；上线前应将任务状态、动态提示词和资产引用迁移到持久化任务表，并用唯一约束协调并发。
  6. API 模式下目录请求失败会回退到本地 SVG 背景，同时 Agent 端点仍会接受该白名单 ID；真实 Gemini 随后会因 SVG 输入返回 `INVALID_INPUT`。生产环境目录不可用时应隐藏 Agent 或拒绝非栅格背景，不能静默降级到不可用素材。
- 建议方向：真实供应商烟测通过并将背景素材替换为授权栅格图后，补充质量基线，再决定是否把该能力扩展到 `gpt-image-2` 等多图编辑 provider，并与 ISSUE-023 的多参考图管线合并评估。

## 2026-09-02 14:54 设计审查记录

- 结论：流程拆分、服务端提示词控制、一次支付幂等和 provider 能力隔离总体合理，适合作为 mock/受控灰度 MVP；当前不建议直接作为真实供应商生产能力发布。
- 新增风险：重试换背景与单支付单任务模型冲突；Agent 运行/完成态只在单进程内存中；API catalog 失败时可能把 SVG 占位背景降级给真实 Agent；并发重放路径缺少资产持久化竞态测试。
- 验证证据：`npx vitest run server/routes/generation.test.ts server/vision/analyze.test.ts server/providers/geminiImageEdit.test.ts`，3 个文件、15 个测试通过。该验证未覆盖真实视觉/Gemini 调用、栅格素材质量、服务重启恢复、多实例一致性和并发重复请求。

## 2026-09-02 15:00 需求确认

- 产品确认：背景不由游客上传，也不使用代码内置的三张背景；由管理员在后台上传背景图片，执行视觉理解并保存分析结果，审核发布后才进入游客端 Agent 背景目录。
- 实施方向：新增背景版本/素材/分析状态管理，游客 Agent 请求只提交已发布 `backgroundId`，服务端读取已保存的栅格背景与预分析提示，不在每次游客请求中重复调用视觉模型。
- 实现记录：新增 `background_versions` 表、`background` 素材类别、后台背景管理页及上传/分析/发布接口；游客目录仅返回已发布且 `analysis_status=ready` 的背景。API/mock 默认不再回退到 `src/mocks/fixtures/backgrounds.ts` 的三张占位图；该 fixture 仅保留给独立测试使用。

## 2026-09-02 15:36 修正与运行验证

- 后台新建或更新草稿时，会校验 `imagePath` 对应的素材确实存在于 `background` 资产目录且 MIME 与扩展名一致，避免引用不存在或错误类别的文件。
- 公开背景素材接口改为精确匹配 `background/<uuid>.(jpg|png|webp)`，并继续要求记录已发布、启用且视觉理解完成，避免模糊路径匹配造成越权读取。
- 验证：`npm run lint`、`npm test`（11 个文件、42 个测试）、`npm run build`、`git diff --check` 均通过；API 重启后 `GET /api/health` 返回 `ok: true`，`GET /api/catalog` 返回 `backgrounds: []`、`runtime.agentEnabled: true`。当前数据库中尚无管理员发布背景，因此游客端不会显示 Agent 背景选项。

## 2026-09-02 15:45 后台新建表单修正

- 原因：后台“新建背景”按钮的 `disabled` 条件隐式要求填写“描述”，但界面没有明确提示，导致管理员只填写名称、动作提示和图片时点击按钮没有任何反馈。
- 修正：描述改为可选，缺少必要字段时点击“保存背景”会显示具体缺少项；保存成功后提示“下一步请执行视觉理解”。列表状态文案将内部 `draft` 改为管理员可理解的“待处理”，弹窗标题和操作按钮不再暴露数据库术语。
- 服务端在描述为空时使用背景名称作为默认描述，保持数据库字段完整。

## 2026-09-02 视觉提示词展示

- 后台背景列表新增“视觉提示词”列，管理员可展开查看视觉理解生成的完整提示词。
- 编辑背景时同步展示只读的“视觉处理后的提示词”文本框；游客目录仍不会收到该字段。

## 2026-09-02 Agent 等待页标题修正

- 修正 Agent 等待页将 `<br />` 作为普通字符串显示的问题，标题现在使用 JSX 正确换行，不再出现原始标签文本。
