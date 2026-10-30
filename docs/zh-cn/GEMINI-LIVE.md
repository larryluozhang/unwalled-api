# Gemini Live 代理接入（che.39）

Unwalled API 现在可以转发 Gemini Live 双向音频会话。这不是 HTTP 请求——Gemini Live 是一个长连接 WebSocket，网关在旁边做**双向逐帧透传**：客户端用统一 key 连网关，网关在服务端用配置的 Google key 连上游 `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`。

## 前置配置（必须）

在模型页**手动添加**一个 Gemini Live 模型：
- 平台：`google`
- 模型 ID：`gemini-2.5-flash-native-audio-latest`（或 `gemini-2.5-flash-preview-native-audio-dialog`）
- 必须 `enabled = 1`

Live 模型不在自动目录里（它是会话制，不参与 REST 回退链），需要手动注册。`catalog-sync` 不会清掉用户手动添加的模型（只清 `source='catalog'`）。

## 客户端接入

**连接地址**（同源，或网关允许的 Origin）：
```
ws://<gateway-host>:3001/v1beta/gemini-live?model=gemini-2.5-flash-native-audio-latest
```

**鉴权**（服务端客户端用 header，浏览器不能设 header）：
- 服务端客户端（Stack-chan 的 Go 进程、Node 脚本等）：`Authorization: Bearer <unwalled统一key>`
- 浏览器：同源自动带 cookie；跨源需配 Origin 白名单。浏览器也可用 `?key=<统一key>`（会进 URL 日志，不推荐）

**协议**：客户端说标准 Gemini Live 协议（setup 消息、16kHz PCM16 音频帧 base64、JSON 控制消息），网关不改协议，逐帧透传。Stack-chan 的 ESP32 固件不需要改——它连的是 stackchan-ai-server 自己的 xiaozhi WS，由 stackchan-ai-server 作为客户端连这个网关。

## Stack-chan 完整链路

```
ESP32 (xiaozhi WS) → stackchan-ai-server → [unwalled 网关 Live 代理] → Google Gemini Live
```

stackchan-ai-server 的 `gemini_client.go` 硬编码了 `wss://generativelanguage.googleapis.com/ws/...`，要让它走网关需要改它的 endpoint（或给网关配本地代理把 `generativelanguage.googleapis.com` 指到网关）。改法：把 `geminiEndpoint` 常量改成网关地址，鉴权从 `?key=` 改成 `Authorization: Bearer <统一key>`（Stack-chan 是 Go 服务端，能设 header）。

## 限制

- **只支持直连**：代理模式（HTTP CONNECT / SOCKS）与 Fetch Relay 无法中继持久双向 WebSocket。需直连上游。
- **不做多上游回退**：Live 是会话制，换模型会断会话。只 pin 一个 google 模型。
- **每 IP 最多 4 个并发 Live 会话**（防 socket 耗尽）。
- **每会话一行分析记录**（caller=`gemini-live`），不逐帧计数。

## 版本
che.39 起可用。
