# 亭机生成一次后不回首页,重启后直接落在拍照页

- 发现时间:`2026-09-14 15:45:00 +08:00`
- 状态:`已解决`
- 级别:P1(直接影响门店接待:下一位游客看到的是上一位的会话,且生成必然失败)
- 发现途径:安卓 APK 实机运行(用户反馈)

## 现象

生成一次并结束后,页面停留在拍照页而不是首页;重启 App 也一样。从拍照页继续走流程,会在最后一步生成失败(权益已消耗)。

## 根因

`src/features/session/SessionProvider.tsx` 的会话恢复逻辑:兑换成功后把
`{id, entitlement, entitlementToken}` 写入 `localStorage['kiosk_session']`;
**只要该存档存在,App 每次启动都恢复并直接跳到 `stage: 'camera'`**。
该机制本意是 WebView 崩溃/刷新后游客不必重新兑码,但存在两个缺陷:

1. 生成完成后权益已被消耗,存档却没有清除 —— 游客扫码后直接离开(没点
   「我已保存,结束体验」)时,存档一直留存,重启后跳过首页落回拍照页;
2. 存档在生成开始后仍会写入,若 WebView 在生成中崩溃,重启后恢复的会话
   权益已废,游客走完全部流程后在最后一步必然失败。

另外整个亭机流程没有任何"无人操作自动复位",游客离场后屏幕停在结果页/下载页。

## 处理结果

- 状态:`已解决`
- 解决时间:`2026-09-14 16:00:00 +08:00`
- 改动:
  - 新增 `src/features/session/sessionPersistence.ts`:快照读写集中在此,并加门禁 ——
    **只有「兑换后、生图前」阶段(camera/review/mode/styles/backgrounds)的快照才可恢复**;
    生成开始即清除快照;旧版本写入的、没有 `stage` 字段的快照视为不可信直接丢弃
    (存量设备升级新包后首次启动自动回到首页)。
  - `SessionProvider.tsx` 改为使用上述模块:恢复时仍落回拍照页(仅限生图未开始的会话)。
  - `KioskFlow.tsx` 新增亭机无人值守:结果页/下载页连续 120 秒无 pointerdown/
    touchstart/keydown 自动 RESET 回首页(交互即重新计时;生成页与拍照页不参与)。
  - 顺带修复 `src/services/apiBase.test.ts` 硬编码旧服务器 IP 的过期断言
    (改为按 `VITE_API_BASE_URL` 当前值验证拼接行为)。
- 验证证据:

  ```text
  npm test                               21 passed(新增 sessionPersistence 5 条:
                                          生图前各阶段保留快照、生成开始/结束/复位清除、
                                          恢复仅限生图前、无 stage 的旧快照丢弃、
                                          生成后阶段快照丢弃)
  npm run lint                           干净
  npm run build                          通过类型检查(tsc -b && vite build)
  ```

- 注意:修复在前端代码内,需重新打包安装 APK 才在设备上生效
  (`焕新造像-v1.0-debug.apk` 已用新代码重打)。
