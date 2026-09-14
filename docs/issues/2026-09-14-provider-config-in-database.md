# 2026-09-14 供应商选择停留在配置文件，与数据库配置不一致

## 文档信息

- 发现时间：`2026-09-14 11:20:00 +08:00`
- 解决时间：`2026-09-14 12:05:00 +08:00`
- 范围：`backend/app/config.py`、`backend/app/model_configs.py`、`backend/app/providers/`（factory / 新增 circuit、failover）、`backend/app/domain/generation_service.py`、`backend/app/api/`（health、admin、generation）、`backend/app/jobs/generation_worker.py`、`backend/app/domain/catalog_service.py`、`src/admin/AdminApp.tsx`
- 关联问题：见 `2026-09-14-generation-provider-resilience.md`（ISSUE-029，同一场的后续）

## 状态定义

见 `2026-08-19-project-review.md`。允许状态：`待处理`、`处理中`、`已解决`、`暂不处理`。

## 问题索引

| 编号 | 优先级 | 状态 | 问题摘要 |
| --- | --- | --- | --- |
| ISSUE-030 | P0 | 已解决 | 供应商实现由 `.env` 的 `AI_PROVIDER` 选择并与数据库配置重叠：数据库 `provider` 列形同虚设、健康检查显示的是假值、备用线路永远不可达 |

## 问题详情

### ISSUE-030：供应商选择与数据库配置脱节

- 优先级：`P0`
- 状态：`已解决`
- 发现时间：`2026-09-14 11:20:00 +08:00`
- 背景：管理员在后台维护了多条 `model_configs` 记录（deepcoding、tokenworldai、baibai），本意是「供应商由数据库决定」。但代码里同时还存在一条并行的选择路径（`.env` 的 `AI_PROVIDER`），两者表达同一件事且没有一致性保证。

- 具体缺陷（均为只读代码审查确认）：

  1. `backend/app/domain/generation_service.py` 的 `_provider_for()` 从数据库读出运行参数后**硬编码返回 `GptImageProvider`**。也就是说 `model_configs.provider` 这一列（`deepcoding` / `tokenworldai`）从来不参与实现选择，只用于后台和日志展示。

  2. `backend/app/providers/factory.py` 用 `providers[settings.ai_provider]` 直接索引字典，非法值会抛 `KeyError` 而不是可读的配置错误。

  3. 展示口径与实际不符：`.env.local` 中 `AI_PROVIDER=gpt-image-2-url`，`/api/health`、`/api/admin/summary`、`/api/catalog` 都据此显示 `gpt-image-2-url`；但真实生效的是 `GptImageProvider`（`name = "gpt-image-2"`），且经典模式实际走的是 `/images/edits`（带游客照片）。**运维看到的供应商名是假的。**

  4. 备用线路不可达：`tokenworldai` 行（`enabled=0`）在库中躺着，但 `get_default_model_config()` 只取 `is_default=1` 一行，且没有任何故障切换逻辑。厂商整体宕机时每个请求都要干等 300 秒超时才失败。

- 影响：
  - 管理员改数据库无法改变实际调用的实现，与「供应商配置进数据库」的设计意图相反；
  - 事故排查会被误导到错误的供应商；
  - 无备用线路，单点厂商故障直接等于业务中断。

## 处理结果

- 状态：`已解决`
- 解决时间：`2026-09-14 12:05:00 +08:00`
- 相关提交：`9e3a85d`（worktree 分支 `workbuddy/codex-python-c2c1df58` 的首次提交，包含本问题的全部改动）

- 变更内容：

  1. **彻底移除 `AI_PROVIDER`**：删除 `Settings.ai_provider`、`ProviderName`、`agent_enabled_by_config`，以及 `model_validator` 中所有依赖它的分支。`.env.example`、`README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/deployment-python.md`、`playwright.config.ts` 同步更新；本地 `.env.local` 里两行重复的 `AI_PROVIDER` 已删除（备份为 `.env.local.bak`，被 `.env.*` 规则忽略）。

  2. **新增供应商解析层**（`backend/app/model_configs.py`）：
     - `resolve_provider_key(row)`：`provider` 列命中已发布实现名（`mock`/`gpt-image-2`/`gpt-image-2-url`/`seedream`/`jimeng-i2i`/`gemini-3.1-flash-image`）时精确选择该实现；否则按 OpenAI 兼容协议处理，默认实现为 `gpt-image-2`。
       - 默认值取 `gpt-image-2` 而非形近的 `gpt-image-2-url`：后者经典模式走 `/images/generations` **不带游客照片**，改成它会改变线上产品行为。这一条有既有测试佐证（`test_classic_generation_uses_database_image_model_config` 断言 `name == "gpt-image-2"`）。
     - `get_active_model_configs(session, model_type)`：返回可用行，默认行优先，其余按 `updated_at` 降序作为备用。

  3. **新增故障降级与熔断**：
     - `backend/app/providers/circuit.py`：进程内 `CircuitBreaker`，连续失败达阈值后跳过该线路，冷却结束后放行一次探测。
     - `backend/app/providers/failover.py`：`FailoverImageProvider` 按优先级依次尝试各线路。**只对「线路故障」切换**（`LINE_FAILURE_CODES`：鉴权失败、限流、超时、瞬时错误、5xx、配置错误）；`INVALID_INPUT` 这类请求本身的问题直接抛出，不浪费备用线路的延迟与成本。

  4. **口径统一**：`/api/health`、`/api/admin/summary`、`/api/catalog`、`/api/admin/health` 的 provider 全部改为读取数据库解析结果。`/api/health` 新增 `implementation`（实现名）与 `standbyLines`（备用线路数）两个字段，`provider` 字段保留管理员填写的店名。

  5. **后台可用性**：`src/admin/AdminApp.tsx` 的供应商字段改为可输入 + 下拉建议（`datalist`），保留自由文本以兼容 `deepcoding` 这类店名，并在弹窗说明中写明「填实现名才会切换实现」。

  6. **无配置即报错**：非 `test` 环境且没有可用行时，生图接口返回 `CONFIG_ERROR`（503），不再静默降级到 mock。`app_env="test"` 仍回退 mock，这是测试与 e2e 的既有约定。

- 验证证据：

  ```text
  pytest backend/tests/                  74 passed（新增 11 条：解析层、熔断、降级、未知 key 回退）
  npm test                               16 passed
  npm run lint                           干净
  npm run build                          通过类型检查

  GET /api/health
    overall: ok
    aiProvider      : ok {"provider": "gpt-image-2", "standbyLines": 0}
    imageGeneration : ok {"provider": "deepcoding", "implementation": "gpt-image-2",
                          "model": "gpt-image-2", "standbyLines": 0, ...}
  GET /api/catalog                       5 风格 / 1 背景，runtime.generationMode = "api"
  GET /api/admin/summary                 provider = "gpt-image-2"
  http://localhost:5173/api/health       HTTP 200
  logs/generation.log                    无异常事件
  ```

  其中 `/api/admin/summary` 的 `provider` 由修复前的 `gpt-image-2-url`（假值）变为 `gpt-image-2`（真实实现），是本问题的直接证据。

## 遗留与后续

- **备用线路当前为 0 条**：`tokenworldai` 行在库中 `enabled=0`，不计入可用行。要让降级生效需在后台把该行「启用」。这是数据侧操作，未擅自改动生产数据。
- **启用后仍需先调超时**：即使启用了备用行，默认 `timeout_ms=300000` 会让单线路重试预算（约 903s）超过前端 660s 上限，导致降级永远不会被触发。详见 `2026-09-14-failover-timeout-budget.md`（ISSUE-031）。
- **非 OpenAI 兼容实现仍依赖各自的环境变量**：`seedream`/`jimeng-i2i`/`gemini-3.1-flash-image` 的凭据形状（Volc AK/SK、Ark Key、Gemini Key）无法用现有 `model_configs` 字段表达，因此 `ARK_*`、`VOLC_*`、`JIMENG_*`、`GEMINI_IMAGE_*` 作为这些实现自身的兜底参数保留。若要求「全部进数据库」，需要先扩展表结构。
- **健康检查仍不探活上游**：`imageGeneration` 的 `ok` 只表示存在配置行，不代表厂商可用。真实探活仍是待办（ISSUE-029 遗留项）。
