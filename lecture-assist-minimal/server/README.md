# lecture-assist/server

本地中枢：
- 浏览器通过 `ws://<host>:4350/ingest` 发送 1s 音频切片（webm/opus）。
- 服务器直连 Soniox WebSocket (`wss://stt-rt.soniox.com/transcribe-websocket`)。
- 初始配置：`audio_format: auto`、`language_hints: ["ja"]`、可选 `translation: {type:"one_way", target_language:"zh"}`、`enable_endpoint_detection: true`。

运行：
```bash
cd server
cp .env.local .env    # 或者直接使用 .env.local
pnpm i  # 或 npm i / yarn
pnpm dev
```
打开 http://localhost:4350 可进行最小化测试页面（无需 Next.js）。

导出 SRT：
```
GET /export/srt
```
