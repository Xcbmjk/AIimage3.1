# 2026-09-14 默认超时预算使备用生图线路不可达

## 文档信息

- 发现时间：`2026-09-14 11:50:00 +08:00`
- 范围：`model_configs.timeout_ms`（数据侧）、`backend/app/providers/http.py`（`MAX_ATTEMPTS`）、`backend/app/providers/failover.py`、`src/services/httpGeneration.ts`、`vite.config.ts`
- 关联问题：`2026-09-14-provider-config-in-database.md`（ISSUE-030，新增了降级链；本问题是它的生效条件缺陷）

## 状态定义

见 `2026-08-19-project-review.md`。允许状态：`待处理`、`处理中`、`已解决`、`暂不处理`。

## 问题索引

| 编号 | 优先级 | 状态 | 问题摘要 |
| --- | --- | --- | --- |
| ISSUE-031 | P1 | 待处理 | ISSUE-030 引入的备用线路在默认配置下永远不会被调用：单线路重试预算 903s 已超过前端 660s 硬上限，前端先超时，降级逻辑没有机会执行 |

## 问题详情

### ISSUE-031：备用线路被超时预算挡在门外

- 优先级：`P1`
- 状态：`待处理`
- 发现时间：`2026-09-14 11:50:00 +08:00`

- 背景：ISSUE-030 让 `model_configs` 的每条启用行成为备用线路（`get_active_model_configs` → `FailoverImageProvider`）。但降级只有在「上一条线路抛错」之后才会发生，而线路内部还有一层重试，两者叠加后的耗时超过了客户端上限。

- 具体缺陷：

  1. **每条线路内部会重试 3 次**：`providers/http.py` 的 `MAX_ATTEMPTS = 3`，且 `UPSTREAM_TIMEOUT` 被标记为 `retryable=True`（`providers/gpt_image.py:56-62`）。单次尝试的超时取自行配置 `timeout_ms`。
  2. **当前数据行的 `timeout_ms = 300000`**（`deepcoding` / `tokenworldai` 均为 300 秒）。因此「厂商挂起不响应」时，一条线路的耗时约为
     `3 × 300s + 退避(1s + 2s) ≈ 903s`。
  3. **客户端硬上限是 660s**：`src/services/httpGeneration.ts:14` 的 `controller.abort()` 与 `vite.config.ts:19` 的代理超时都是 `660000`。`/api/generation` 是同步长请求，没有轮询兜底。
  4. 于是 `903s > 660s`：**前端先断开，服务端还没走到 `FailoverImageProvider` 的下一条线路**，备用配置形同虚设。

- 补充缺陷（同一个问题域）：熔断阈值默认 `PROVIDER_FAILURE_THRESHOLD = 3`，而熔断是按「线路失败次数」计，**每个风格只贡献 1 次失败**（`retry_operation` 在 provider 内部完成，对外只抛 1 个 `ProviderError`）。因此阈值 3 意味着一个请求里的前 3 个风格都会在主线路上把重试预算烧完，备用线路要到第 4 个风格才有机会——单请求内几乎不可能触发。

- 实测依据（只读查询远程库 `aiimage-py`）：

  ```text
  generation_jobs 共 12 条：agent/succeeded=3、classic/succeeded=8、classic/failed=1
  单任务耗时（含 1 个风格）：min=6s  中位=50s  max=384s
  多数任务 attempts=1，个别 attempts=2 / 6
  ```

  即单张图的正常耗时约 45–59 秒，`timeout_ms = 300000` 有约 5 倍余量，明显偏大；但直接压到 60s 以下会误杀正常请求。

- 影响：
  - 管理员在后台启用备用行后，`standbyLines` 会变成 1，**看起来已生效，但实际故障场景下不会被使用**，属于「配置显示成功、行为不符合预期」。
  - 线上故障时表现为「游客等待 11 分钟后失败」，而不是「快速切换到备用厂商」。

## 处理建议（尚未实施）

均可在**不改代码**的前提下缓解：

1. **调小 `timeout_ms`**（后台「图片生成模型」逐条编辑）：建议 `300000 → 120000`。以实测中位 50s 计仍有 2.4 倍余量，不会误杀正常请求；单线路最坏耗时降到约 363s，为备用线路留出预算。
2. **调低熔断阈值**：在唯一的 `.env.local` 中加 `PROVIDER_FAILURE_THRESHOLD=1`，并在改动后重启 API。这样第一个风格失败即打开该线路，后续风格直接走备用，避免反复烧预算。
3. 启用 `tokenworldai` 行（当前 `enabled=0`）使其进入降级链。这是数据侧操作，未擅自改动生产数据。

若要彻底解决多风格 + 挂起型故障的组合（4 风格串行时 660s 仍可能不够），需要代码层改动，可选：把 `MAX_ATTEMPTS` 中「超时」与「可重试错误」分开（超时不重试、直接降级）、提高前端/Vite 超时上限、或把风格生成改为并发。这些需要与测试同步修改，未在本轮实施。

## 遗留与后续

- 备用线路只覆盖「主线路失败」。主线路能返回但质量下降时不会自动切换，需要人工在后台「设为默认」。
- 视觉分析（`vision_analysis`，当前 `baibai`）仍走单行配置 `get_default_model_config`，**没有降级链**；`/api/health` 的 `agentVision` 也没有 `standbyLines` 字段。
- 上述缓解措施已写入 `.env.example` 的注释说明。
