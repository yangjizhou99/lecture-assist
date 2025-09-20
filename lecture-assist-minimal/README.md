# Lecture Assist (Minimal Skeleton)

用途：教室/线上日语授课，<=10s 延迟，中日双语（原文日语 + 中文翻译），**所有数据仅存本机**。  
ASR/翻译：Soniox 实时流式 WebSocket。前端：Next.js（PWA 级别的简化版）。

## 目录
```
lecture-assist/
├─ server/      # 本地中枢：浏览器音频 -> Soniox -> 双语字幕 -> 本地存储
└─ web/         # Next.js 简易前端（可选；server 自带超简测试页 http://localhost:4350）
```

## 快速开始
1. 在 Soniox 控制台获取 API Key；复制 `server/.env.local` → `server/.env`，填入 `SONIOX_API_KEY`。
2. 启动 server：
   ```bash
   cd server && pnpm i && pnpm dev
   ```
   打开 `http://localhost:4350`（内置极简页），或启动前端：
3. 启动 web（可选 Next.js）：
   ```bash
   cd web && pnpm i && pnpm dev
   ```
   访问 `http://localhost:4300`。手机/平板在同一 Wi‑Fi 下访问 `http://<你的笔记本IP>:4300`。
4. 导出字幕（SRT）：`http://localhost:4350/export/srt`

## 说明
- 浏览器以 `audio/webm; codecs=opus` 每 1s 分片发送；Server 端用 Soniox `audio_format: "auto"` 自动识别容器，不需你手动转码。
- Server 默认开启 `enable_endpoint_detection: true`；若 2s 无音频分片，会发送 `{"type":"finalize"}` 让 Soniox 立即“定稿”。
- 最小化存储：`server/storage/YYYYMMDD_course/time/` 下保存 `transcript.jsonl`（每行一个定稿段）与可选 `audio/*.webm` 分片。

> 参考：Soniox WebSocket 端点、配置与实时翻译、端点检测与手动 finalize：
> - WebSocket API（端点、配置、响应结构）  
> - 实时翻译（one_way / two_way）  
> - 端点检测（<end> 标记）与手动 finalize（{"type":"finalize"}）
