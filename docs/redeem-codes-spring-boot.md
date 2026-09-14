# 小程序请求头 Token 领取兑换码：历史文档

> [!WARNING]
> 本文档已废弃，仅作为旧方案留档。当前产品不提供小程序或其他外部系统领取兑换码的接口，也不提供 `POST /api/redeem-codes/claim`。
>
> 当前兑换码只能由管理员登录 `/admin/` 后批量生成，游客在一体机页面调用 `POST /api/entitlements/redeem` 兑换使用。请以 [Python 后端部署与启动手册](deployment-python.md) 和项目当前 API 为准。

> 这份文档写给负责实现小程序后端的 AI 或 Java 工程师。阅读后可以直接开始编码，不需要猜测接口行为。

## 1. 目标

小程序已经有自己的登录态或业务 token。小程序后端调用山境造像服务时，只需要把这个 token 放进 HTTP 请求头。

山境造像服务的规则：

- 不解析 token 的格式。
- 不要求 token 以 `mp_`、JWT 或其他前缀开头。
- 不把 token 放在 URL、JSON body 或 query string 中。
- 服务端只对 token 原文做 SHA-256 哈希并保存。
- 同一个 token 只能成功领取一次兑换码。
- 首次出现的非空 token 会自动登记并生成一个 8 位兑换码。

小程序后端拿到兑换码后，再把兑换码交给用户。用户在山境造像页面输入兑换码，获得一次生图权益。

## 2. 系统边界

有两个服务器：

1. **小程序后端（Spring Boot）**
   - 负责小程序登录、用户身份和自己的 token。
   - 调用山境造像服务领取兑换码。
   - 不需要访问山境造像数据库。
2. **山境造像服务（Node.js/Express）**
   - 提供兑换码和生图 API。
   - 记录 token 的哈希和领取状态。
   - 生成兑换码并限制一次性使用。

两个服务器可以是不同机器、不同云厂商、不同网络，只要小程序后端能够通过 HTTP 访问山境造像服务地址。

当前项目允许使用 HTTP。示例地址：

```text
http://your-public-server:8787
```

把 `your-public-server:8787` 替换成实际公网 IP 或域名。不要把 `localhost` 写进生产配置；`localhost` 只表示当前服务器自己。

## 3. 核心业务流程

```text
用户打开小程序
    |
    v
小程序后端取得自己的 userToken
    |
    | POST /api/redeem-codes/claim
    | Header: X-Mini-Program-Token: userToken
    v
山境造像服务按 token 哈希查找
    |
    +-- 第一次出现 --> 创建 token 记录 --> 生成 8 位兑换码 --> 返回 code
    |
    +-- 已领取过   --> 返回 409 MINI_TOKEN_CLAIMED
    |
    v
小程序后端把兑换码交给用户
    |
    v
用户在生图页面输入兑换码
    |
    | POST /api/entitlements/redeem
    | JSON: code + sessionId
    v
山境造像服务返回 accessToken
    |
    v
后续生图请求使用 X-Payment-Token
```

一个请求头 token 对应一个兑换码，一个兑换码对应一次生图权益。

## 4. 领取兑换码接口

### 4.1 请求

```http
POST http://your-public-server:8787/api/redeem-codes/claim
X-Mini-Program-Token: <小程序自己的 token>
```

请求不需要 JSON body。建议同时发送：

```http
Accept: application/json
Content-Length: 0
```

完整 curl 示例：

```bash
curl -i -X POST \
  "http://your-public-server:8787/api/redeem-codes/claim" \
  -H "Accept: application/json" \
  -H "X-Mini-Program-Token: wx-user-token-abc.2026"
```

`X-Mini-Program-Token` 的值是完全不透明的字符串。实际 token 可以包含斜杠、点号、冒号等字符，服务端不会解析或改写它。

### 4.2 成功响应

HTTP `200`：

```json
{
  "code": "A7K3P9Q2"
}
```

兑换码固定为 8 位，只使用大写字母和数字，并排除容易混淆的字符 `O/0`、`I/1`。

服务端只在这次响应中返回完整兑换码。后台列表只显示兑换码前缀，无法从列表恢复完整码。小程序后端收到后应立即保存或交给用户，不要依赖再次查询。

### 4.3 错误响应

| HTTP 状态 | `code` | 触发条件 | 小程序后端处理 |
| --- | --- | --- | --- |
| 400 | `INVALID_INPUT` | 请求头不存在、为空或长度超过 1024 | 检查请求头和 token，不要重试空 token |
| 409 | `MINI_TOKEN_CLAIMED` | 相同 token 已经成功领取过兑换码 | 不要自动重试；从本地业务记录中取已发出的兑换码 |
| 410 | `MINI_TOKEN_EXPIRED` | token 记录已过期 | 提示重新登录或重新获取业务 token |
| 410 | `MINI_TOKEN_DISABLED` | token 被服务端禁用 | 联系服务端管理员 |

错误响应示例：

```json
{
  "code": "MINI_TOKEN_CLAIMED",
  "message": "该请求头 token 已领取过兑换码"
}
```

当前实现对首次出现的非空 token 自动登记，因此正常情况下不存在 `404 MINI_TOKEN_INVALID`。如果未来服务端增加白名单校验，可能重新启用该错误码；客户端应把未知的 4xx 当作不可重试业务错误处理。

## 5. Spring Boot 实现

以下示例使用 Spring Boot 3 的 `RestClient`。小程序后端只传请求头，不发送 body。

### 5.1 配置

`application.yml`：

```yaml
shan-jing:
  redeem-base-url: http://your-public-server:8787
```

不要把 token 放入配置文件。token 必须来自当前小程序用户的业务上下文。

### 5.2 DTO 和异常

```java
public record ClaimCodeResponse(String code) {}

public class RedeemAlreadyClaimedException extends RuntimeException {
    public RedeemAlreadyClaimedException() {
        super("该小程序 token 已领取过兑换码");
    }
}

public class RedeemRemoteException extends RuntimeException {
    private final String errorCode;

    public RedeemRemoteException(String errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public String errorCode() {
        return errorCode;
    }
}
```

### 5.3 HTTP 客户端

```java
import org.springframework.http.HttpStatusCode;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

public final class ShanJingRedeemClient {
    private final RestClient client;

    public ShanJingRedeemClient(RestClient.Builder builder, String baseUrl) {
        this.client = builder.baseUrl(baseUrl).build();
    }

    public String claimCode(String miniProgramToken) {
        if (miniProgramToken == null || miniProgramToken.isBlank()) {
            throw new IllegalArgumentException("小程序 token 为空");
        }

        try {
            ClaimCodeResponse response = client.post()
                    .uri("/api/redeem-codes/claim")
                    .header("X-Mini-Program-Token", miniProgramToken)
                    .header("Accept", "application/json")
                    .retrieve()
                    .body(ClaimCodeResponse.class);

            if (response == null || response.code() == null || response.code().isBlank()) {
                throw new RedeemRemoteException("EMPTY_RESPONSE", "兑换码服务返回为空");
            }
            return response.code();
        } catch (RestClientResponseException exception) {
            HttpStatusCode status = exception.getStatusCode();
            if (status.value() == 409) {
                throw new RedeemAlreadyClaimedException();
            }
            if (status.value() == 400) {
                throw new RedeemRemoteException("INVALID_INPUT", "请求头 token 无效");
            }
            if (status.value() == 410) {
                throw new RedeemRemoteException("TOKEN_UNAVAILABLE", "请求头 token 已失效");
            }
            throw new RedeemRemoteException("REMOTE_ERROR", "兑换码服务暂时不可用");
        }
    }
}
```

生产代码必须设置连接超时和读取超时。网络超时后状态可能未知，不能直接再次领取；先查本地记录。不要自动重试 `409 MINI_TOKEN_CLAIMED`。

### 5.4 本地幂等表

小程序后端应保存 token 哈希与兑换码，避免用户重复点击时再次调用远端：

```sql
CREATE TABLE issued_redeem_codes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id VARCHAR(128) NOT NULL,
    mini_token_hash CHAR(64) NOT NULL UNIQUE,
    redeem_code CHAR(8) NOT NULL,
    created_at TIMESTAMP NOT NULL,
    UNIQUE KEY uq_issued_redeem_code (redeem_code)
);
```

保存规则：

- 保存 `SHA-256(token)`，不要保存原 token。
- `mini_token_hash` 必须有唯一索引。
- 兑换码只保存给当前业务需要的用户。
- 不在日志、异常、埋点中输出 token 或兑换码。

业务伪代码：

```java
public String issueCodeForUser(String userId, String miniProgramToken) {
    String tokenHash = Sha256.hex(miniProgramToken);
    return repository.findByTokenHash(tokenHash)
            .map(IssuedRedeemCode::redeemCode)
            .orElseGet(() -> {
                String code = remoteClient.claimCode(miniProgramToken);
                repository.insert(userId, tokenHash, code);
                return code;
            });
}
```

并发请求必须由数据库唯一键、分布式锁或用户级锁保护。远端也会按 token 哈希保证最终只能成功一次，但本地仍要避免并发重复调用。

### 5.5 给小程序前端的 Spring Boot 接口

小程序前端不要直接访问山境造像服务。推荐由 Spring Boot 暴露自己的业务接口：

```http
POST /api/mini-program/redeem-code
Authorization: Bearer <小程序登录凭证>
```

Controller 从登录上下文取得 `userId` 和小程序自己的 token，再调用 `issueCodeForUser`。不要接受客户端提交的任意 `userId`。

成功返回：

```json
{
  "code": "A7K3P9Q2"
}
```

建议的业务错误：

| Spring Boot HTTP | 含义 |
| --- | --- |
| 200 | 首次成功，或返回本地已保存的同一兑换码 |
| 409 | 该用户/token 已领取过 |
| 502 | 山境造像服务返回未知错误 |
| 504 | 连接或读取超时，状态未知 |

## 6. 重试与幂等规则

1. `400 INVALID_INPUT`：不重试，修正请求头。
2. `409 MINI_TOKEN_CLAIMED`：不重试。token 已消费。
3. `410`：不重试，换新的业务 token。
4. 网络超时：先查询本地 `issued_redeem_codes`；没有记录时标记为“状态未知”，交由人工或受控任务处理。
5. HTTP `5xx`：最多有限重试 1 次，使用指数退避；不要高频循环。
6. 用户重复点击：优先返回本地已保存兑换码。

## 7. 用户使用兑换码获得生图权益

领取接口只负责“请求头 token -> 兑换码”。用户真正获得生图权益还需要调用：

```http
POST http://your-public-server:8787/api/entitlements/redeem
Content-Type: application/json

{
  "code": "A7K3P9Q2",
  "sessionId": "16de9a80-f226-45be-8c2d-f9f632aa0140"
}
```

成功响应：

```json
{
  "accessToken": "server-issued-access-token",
  "entitlement": {
    "code": "A7K3P9Q2",
    "status": "used",
    "maxStyles": 4,
    "expiresAt": "2026-09-10T12:00:00.000Z"
  }
}
```

后续经典生图、Agent 生图和分享请求使用：

```http
X-Payment-Token: server-issued-access-token
```

不要把 `X-Mini-Program-Token` 当成生图授权令牌；两者用途完全不同。

## 8. 后台管理员操作

管理员可以在后台“兑换码”页面直接生成普通兑换码：

```http
POST http://your-public-server:8787/api/admin/redeem-codes/generate
Content-Type: application/json
Cookie: admin_session=...
X-CSRF-Token: ...

{
  "count": 10,
  "expiresAt": "2026-10-01T00:00:00.000Z"
}
```

小程序新接入不需要调用后台接口，也不需要预先生成 token。旧的小程序 token 生成接口仅为兼容旧流程保留。

## 9. 联调步骤

1. 确认服务可访问：

   ```bash
   curl http://your-public-server:8787/api/health
   ```

2. 使用一个包含特殊字符的测试 token 首次领取：

   ```bash
   curl -i -X POST \
     http://your-public-server:8787/api/redeem-codes/claim \
     -H "X-Mini-Program-Token: ai/test.token:v1"
   ```

   预期：HTTP `200`，响应包含 8 位 `code`。

3. 使用完全相同的 token 再次领取。

   预期：HTTP `409`，`code=MINI_TOKEN_CLAIMED`。

4. 使用不同 token 领取。

   预期：HTTP `200`，得到不同兑换码。

5. 使用第 2 步返回的兑换码调用 `/api/entitlements/redeem`。

   预期：HTTP `200`，得到 `accessToken`。

6. 再次使用同一个兑换码兑换。

   预期：HTTP `409`，兑换码已使用。

7. 检查日志。

   预期：日志中没有原始 token、兑换码、图片、base64 或 accessToken。

## 10. 给另一个 AI 的直接执行任务

将下面内容完整交给负责小程序后端的 AI：

```text
你要在现有 Java Spring Boot 项目中接入山境造像兑换码服务。

目标：
1. 从当前登录用户上下文取得小程序已有 token。
2. 调用 POST {SHAN_JING_BASE_URL}/api/redeem-codes/claim。
3. 请求头设置 X-Mini-Program-Token: <原始 token>。
4. 请求不发送 JSON body，不解析 token，不 trim、不转大写、不 Base64 编码、不改写 token。
5. 成功读取 {"code":"8位兑换码"}。
6. 将 token 的 SHA-256 哈希和兑换码写入本地数据库，token 哈希必须唯一。
7. 同一用户重复请求优先返回本地已保存的兑换码；远端 409 时返回业务冲突，不要自动重试。
8. 连接超时、读取超时和 5xx 只做有限重试；超时后状态未知，不能直接告诉用户领取失败。
9. 不在日志、异常、埋点或响应中输出原始 token。
10. 暴露 POST /api/mini-program/redeem-code 给小程序前端，身份从登录态取得，不接受客户端传入任意 userId。

必须实现：
- 配置项 SHAN_JING_BASE_URL。
- RestClient 客户端。
- 请求响应 DTO。
- 本地 issued_redeem_codes 表和 Repository。
- 业务 Service。
- Controller。
- 400/409/410/5xx 的错误映射。
- 单元测试：成功、同 token 幂等、远端 409、空 token、远端超时。
- 集成测试：使用 WireMock 或 MockWebServer 模拟山境造像服务。

验收标准：
- 首次请求发送 X-Mini-Program-Token，body 为空。
- token 中包含斜杠、点号、冒号等字符时仍能成功。
- 相同 token 并发请求不会产生两条本地记录。
- 409 不会生成第二个兑换码。
- 日志和异常消息不包含 token 原文。
- 配置可在开发、测试、生产环境分别覆盖。
```

## 11. 交付前检查清单

- [ ] 生产配置不是 `localhost`。
- [ ] 请求使用 `X-Mini-Program-Token`，不是 JSON body。
- [ ] token 原文没有被 trim、转大写、Base64 编码或 JWT 解析。
- [ ] token 哈希有唯一索引。
- [ ] 同一 token 重复调用不会申请新兑换码。
- [ ] `409 MINI_TOKEN_CLAIMED` 不自动重试。
- [ ] 超时场景有“状态未知”处理。
- [ ] 原始 token、兑换码、accessToken 没有写入日志。
- [ ] 已领取兑换码可以在小程序后端查询并再次展示给同一用户。
- [ ] 已完成 Spring Boot 单元测试和接口联调。
