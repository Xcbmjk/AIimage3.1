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

## 2026-09-02 价格与支付流程完善

- 后台价格管理改为版本化操作台：按元录入、显示当前生效价格、历史版本和待发布版本，发布前二次确认；新价格只影响后续新建订单。
- 支付页补充订单创建失败重试、支付状态错误提示、二维码过期后重新生成订单，并在支付成功或过期后停止继续轮询。
- 支付重试按钮样式已归位到 kiosk 全局样式，后台与访客端样式边界保持一致。

## 2026-09-02 退款申请流程接入

- 后台“退款申请”页面已接入数据库退款记录：运营可提交申请，老板可批准或拒绝。
- 批准后 mock 支付直接完成退款；微信支付模式调用微信 APIv3 原路退款接口，并把退款单号与执行状态写回数据库。
- 订单与退款操作均保留审计事件，重复申请、非已支付订单和已处理申请会被拒绝。
- 后台退款页新增已支付订单选择、退款原因和“提交退款申请”入口，运营可发起申请，老板继续负责审核。

## 2026-09-02 视觉模型健康信息

- `/api/health` 的 `checks.agentVision.details` 现在返回视觉理解模型名称和配置完整性，不包含 API Key 等敏感字段。
- 后台“系统监控”页新增“视觉理解模型”卡片，并改为读取健康接口的 `checks` 结构，展示与 API 一致的状态。

## 2026-09-11 用户端 Agent 入口未显示

- 现象：用户端“选择创作方式”页面没有 Agent 智能生图入口。
- 原因：`/api/catalog` 和 `/api/agent/generation` 原先只依据 `.env.local` 的 `AI_PROVIDER` 判断 Agent 是否可用；当前环境值为 `gpt-image-2-url`，因此即使数据库已经配置默认视觉模型、默认图片生成模型和已发布背景，接口仍返回 `runtime.agentEnabled=false`。
- 解决：Agent 可用性改为依据数据库中的默认 `vision_analysis` 与 `image_generation` 配置，并保留已发布且已完成视觉理解的背景作为必要条件。图片生成服务已支持数据库图片模型的 `/images/edits`，不再要求环境变量必须写成 `gemini-3.1-flash-image`。
- 验证：重启 API 后 `GET /api/catalog` 返回 `runtime.agentEnabled=true`；`GET /api/health` 返回 `status=ok`，视觉模型、图片模型和数据库均为 `ok`。相关回归测试通过。

## 2026-09-10 视觉模型后台配置

- 视觉分析模型不再从 `.env.local` 读取 `VISION_*` 配置。
- 新增数据库 `model_configs` 表，按 `model_type` 区分模型类别；当前后台开放 `vision_analysis`，为后续生图模型等类别保留扩展字段。
- 后台新增“视觉模型”页面，支持保存、编辑、启用、停用、设置默认模型、获取 NewAPI 兼容 `/models` 列表和测试联通性。
- 视觉分析请求读取数据库中启用的默认视觉模型；未配置时后台背景分析返回明确的配置错误。
- API Key 按当前产品要求明文保存和展示，不写入运行日志；数据库备份和管理员权限仍需按生产规范保护。
- 验证证据：Alembic `004_model_configs` 在本机 MySQL 升级成功；`python -m pytest backend/tests -q`（50 项）、`npm run lint`、`npm run build` 通过；运行态 `/api/health`、`/api/catalog` 和后台页面返回 200，未登录模型配置接口返回 401。

## 2026-09-10 视觉模型联通测试反馈

- 发现问题：模型列表页的“测试联通”结果只写入弹窗状态，列表页不可见，用户点击后无法判断请求是否发出或失败原因。
- 解决情况：将结果提示移动到列表工具栏区域，测试期间按钮显示“测试中…”并禁止重复提交；网络异常和接口错误均显示明确反馈。
- 验证证据：`npm run lint`、`npm test -- --run`（16 项）、`npm run build` 和 `git diff --check` 通过。

## 2026-09-04 真实 Agent 合成鉴权失败

- 发现时间：`2026-09-04 14:23:10 +08:00`
- 状态：`处理中`
- 现象：Agent 请求的背景预分析已成功读取，但图像合成请求失败；`POST /api/agent/generation` 返回 `502`。
- 证据：`logs/generation.log` 中 requestId `36f81736-5558-4b0c-bee7-3de20e389382` 记录 `agent.failed`，错误码 `UPSTREAM_AUTH`，上游状态 `403`，耗时约 `1320ms`，原因标记为 `new_api_error`。同一支付会话随后使用相同任务重试，因幂等状态返回 `409`，不是新的上游失败。
- 初步原因：当前 `gemini-3.1-flash-image` 配置的上游 API 凭据或模型访问权限被拒绝。`/api/health` 的 `configured: true` 只表示配置非空，不代表上游密钥可用或账号有权限。
- 验证：视觉提示词阶段记录 `agent.prompt_generated` 成功；API、MySQL、存储和配置健康检查均为 `ok`。此前同一 provider 曾成功合成，需检查当前 Gemini 上游 API Key、账号权限、模型授权及接口地址是否仍有效；不得把密钥写入日志或问题记录。
