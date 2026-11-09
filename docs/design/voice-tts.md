# 语音（TTS）统一方案

> 2026-10-30 起：手机和网页用同一份参数合成，声音一致。

## 为什么要统一

原来两条链路：

| 端 | 链路 | 声音 |
| --- | --- | --- |
| App | 本地设置 → `/api/app/tts`（Worker 代理 Azure） | 手机选的音色 |
| 网页 | `/api/tts` 建任务 → **手机**合成 → R2 → 网页播放 | 取决于手机在不在线 |
| 网页兜底 | MeloTTS | 完全不同的声音 |

手机不在线、或 8 秒内没响应，网页就掉到 MeloTTS——这就是「网页和手机声音不一样」。

## 现在的链路

```text
App 设置变更 / 每次启动
  → POST /api/app/tts-config  { voice, rate, pitch, style_degree, style_mode }
  → KV tts:config

网页点播放
  → POST /api/tts/speak { text }
  → 读 KV tts:config
  → styleForText(text) 挑情绪（和 App 同一份关键词表）
  → R2 命中 tts/cache/<sha256>.mp3 ？直接返回 : 调 Azure 合成后写 R2
  → 返回 mp3 + 响应头 x-tts-key

兜底顺序：Azure（云端配置） → 手机任务队列 → MeloTTS → 浏览器 speechSynthesis
```

## 关键点

| 点 | 说明 |
| --- | --- |
| 密钥 | `AZURE_SPEECH_KEY` 只在 Worker secret，接口只回参数，不回密钥 |
| 缓存 key | `sha256(text + voice + rate + pitch + style_degree + style)`，换音色不会播到旧音频 |
| 成本 | Azure neural ≈ ¥0.01 / 100 字；命中缓存后 0 |
| 注入防护 | `sanitizeTtsConfig` 用白名单正则卡 voice/rate/pitch/degree，挡住 SSML 注入 |
| 兼容 | 老的 `/api/tts` 任务队列保留，不删 |

## 相关文件

- `src/tts-config.ts` — 配置读写、style 映射、SSML、缓存、合成
- `src/index.ts` — `GET/POST /api/app/tts-config`、`POST /api/tts/speak`、`GET /api/tts/config`
- `public/index.html` — `fetchTtsKey` 先走 `/api/tts/speak`，失败才回落到手机任务
- `ds-mobile/.../speech/TtsConfigSync.kt` — 手机端上传配置