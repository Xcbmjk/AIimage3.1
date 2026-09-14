# 项目日报

日期：2026-09-07  
项目：山境造像 · AI 旅拍一体机

## 今日完成

1. 完成安卓 APK 封装基础
   - 引入 Capacitor Android 工程。
   - 新增 `capacitor.config.ts` 和 Android Gradle 工程。
   - 增加 `CAMERA`、`INTERNET` 权限。
   - 开启 Android WebView 的 HTTP 明文访问。
   - 增加 `android:sync`、`android:open`、`android:build` 命令。

2. 完成安卓端公网 API 地址配置
   - 新增 `VITE_API_BASE_URL` 环境变量。
   - 目录、支付、经典生图、Agent 生图、分享、事件和模拟支付请求统一支持绝对 API 地址。
   - 未配置时继续使用原有 `/api` 路径，桌面开发流程不受影响。

3. 完成 Android WebView 跨域访问支持
   - 服务端新增可配置 `CORS_ORIGINS`。
   - 默认允许 `capacitor://localhost` 和 `http://localhost`。
   - 支持 WebView 所需的预检请求和请求头。

4. 更新项目协作约束
   - 在 `AGENTS.md` 中明确单台安卓设备、公网 HTTP 后端、设备系统摄像头和不使用 HTTPS 的部署约束。
   - 增加“代码修改后必须测试，测试通过后自动提交并说明改动内容”的规则。

## 验证结果

- `npm run lint`：通过。
- `npm test`：13 个测试文件、54 个测试全部通过。
- `npm run build`：通过。
- `npx cap sync android`：通过。
- API 重启后 `/api/health`：HTTP 200。
- `http://localhost` CORS 预检：HTTP 204。
- `capacitor://localhost` CORS 预检：HTTP 204。

## Git 提交

- `b80da44`：配置 Android 公网 API 地址。
- `754bb8d`：增加 Android API 来源的 CORS 支持。
- `717d70c`：加入 Android WebView 封装工程和权限配置。

## 当前问题

- 当前开发机没有安装 JDK，执行 `npm run android:build` 时停在 Gradle 编译前，报错为 `JAVA_HOME is not set and no 'java' command could be found`。
- Android APK 尚未生成，需要在安装 Android Studio、JDK 和 Android SDK 的环境中执行：

```bash
npm run android:build
```

## 明日计划

1. 在具备 JDK 和 Android SDK 的环境生成 Debug APK。
2. 在目标安卓设备安装 APK，验证摄像头权限和拍照预览。
3. 配置 `VITE_API_BASE_URL` 为公网 Node.js HTTP 地址。
4. 验证安卓设备到服务器的目录、支付、经典生图和 Agent 生图流程。
5. 根据真机验证结果补充设备兼容性问题记录。
