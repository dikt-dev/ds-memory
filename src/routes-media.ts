/**
 * 媒体、语音与外链预览：上传、回放、TTS 任务队列、链接元信息抓取。
 *
 * 从 index.ts 拆出来。这一组接口的共同点是「都围绕附件」：图片/视频进 R2、
 * 语音走任务队列（手机优先、网页兜底）、外链只取标题描述且限制内网地址。
 * 鉴权分三种（Bearer / 设备 Token / 登录 Cookie），所以各路由自己带中间件。
 */
import type { Hono } from 'hono';
import type { Env } from './types';
import { checkQueueAuth } from './queue-auth';
import { requireApp, requireAuth } from './middleware';
import SparkMD5 from 'spark-md5';
import { dateKeyInBeijing } from './date';
import { buildAudioKey, buildImageKey, parseByteRange } from './media';
import { getObject, putObject } from './storage';
import { ackTtsJob, claimTtsJob, createTtsJob, fallbackTtsJob, getTtsJob, nackTtsJob } from './tts';
import { loadTtsConfig, saveTtsConfig, speakWithCache } from './tts-config';
import { getStatusSnapshot } from './status';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

const BILI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function biliSign(params: Record<string, string | number>, mixinKey: string) {
  const signed: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) };
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed)) {
    cleaned[k] = String(v).replace(/[!'()*]/g, '');
  }
  const query = Object.keys(cleaned).sort().map((k) =>
    `${encodeURIComponent(k)}=${encodeURIComponent(cleaned[k])}`
  ).join('&');
  return `${query}&w_rid=${SparkMD5.hash(query + mixinKey)}`;
}

async function biliMixinKey(headers: Record<string, string>): Promise<string | null> {
  try {
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers });
    const json = await nav.json() as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
    const wbi = json.data?.wbi_img;
    if (!wbi?.img_url || !wbi.sub_url) return null;
    const img = wbi.img_url.split('/').pop()?.split('.')[0] ?? '';
    const sub = wbi.sub_url.split('/').pop()?.split('.')[0] ?? '';
    const orig = img + sub;
    return BILI_MIXIN_TAB.map((i) => orig[i] ?? '').join('').slice(0, 32);
  } catch {
    return null;
  }
}

export function registerMediaRoutes(app: Hono<AppEnv>): void {
  /**
   * 原图直传（QQ 大 GIF 用）：Bearer 鉴权，raw binary → R2，不压缩。
   * 避免把 6MB 图片 base64 塞进 8MB JSON 后在 TLS 层断连。
   */
  app.post('/api/upload/image', async (c) => {
    if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
    const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(gif|png|jpe?g|webp)$/.test(mime)) {
      return c.json({ error: 'unsupported image type' }, 415);
    }
    const maxBytes = 20 * 1024 * 1024;
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json({ error: 'image too large' }, 413);
    }
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) {
      return c.json({ error: 'image too large' }, 413);
    }
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
    const dateKey = dateKeyInBeijing(new Date());
    const key = buildImageKey(dateKey, Date.now(), ext);
    await putObject(c.env, key, buf, { contentType: mime });
    return c.json({ ok: true, key, mime, bytes: buf.length });
  });

  /** 语音直传（手机端收到 QQ 语音后转码 MP3，再上传）。 */
  app.post('/api/upload/audio', async (c) => {
    if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
    const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const allowed: Record<string, string> = {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/webm': 'webm',
    };
    const ext = allowed[mime];
    if (!ext) return c.json({ error: 'unsupported audio type' }, 415);
    const maxBytes = 10 * 1024 * 1024;
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json({ error: 'audio too large' }, 413);
    }
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) {
      return c.json({ error: 'audio too large' }, 413);
    }
    const key = buildAudioKey(dateKeyInBeijing(new Date()), Date.now(), ext);
    await putObject(c.env, key, buf, { contentType: mime });
    return c.json({ ok: true, key, mime, bytes: buf.length });
  });

  /** 网页创建 TTS 任务：手机优先，网页轮询；超时走 fallback。 */
  app.post('/api/tts', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 300) : '';
    if (!text) return c.json({ error: 'text 不能为空' }, 400);
    const jobId = await createTtsJob(c.env, text);
    if (!jobId) return c.json({ error: '创建任务失败' }, 500);
    return c.json({ ok: true, job_id: jobId, status: 'pending' });
  });

  /** 网页轮询 TTS 任务。 */
  app.get('/api/tts/jobs/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const job = await getTtsJob(c.env, id);
    if (!job) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, id: job.id, status: job.status, audio_key: job.audio_key });
  });

  /** 手机超时后由网页触发 MeloTTS 兜底。 */
  app.post('/api/tts/jobs/:id/fallback', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const key = await fallbackTtsJob(c.env, id).catch(() => null);
    if (!key) return c.json({ error: 'TTS 兜底失败' }, 502);
    return c.json({ ok: true, id, status: 'done', audio_key: key });
  });

  /** 手机拉取一个待合成任务。 */
  app.get('/api/tts/pending', async (c) => {
    if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
    const job = await claimTtsJob(c.env);
    return c.json({ ok: true, job });
  });

  /** 手机合成完成：回传 R2 key。 */
  app.post('/api/tts/ack', async (c) => {
    if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; audio_key?: unknown } | null;
    const id = Number(body?.id);
    const key = typeof body?.audio_key === 'string' ? body.audio_key : '';
    if (!Number.isFinite(id) || !key) return c.json({ error: 'bad request' }, 400);
    await ackTtsJob(c.env, id, key);
    return c.json({ ok: true });
  });

  /** 手机合成失败：重试或让网页走兜底。 */
  app.post('/api/tts/nack', async (c) => {
    if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    const id = Number(body?.id);
    if (!Number.isFinite(id)) return c.json({ error: 'bad request' }, 400);
    await nackTtsJob(c.env, id);
    return c.json({ ok: true });
  });

  /** 聊天语音回放（需登录；audio/ 下，主账号优先、小号兜底）。 */
  app.get('/api/audio/*', requireAuth, async (c) => {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/audio\//, ''));
    // audio/ 是 App 上传的音频；tts/ 是服务端合成的缓存（见 tts-config.ts）
    if (!key.startsWith('audio/') && !key.startsWith('tts/')) {
      return c.json({ error: 'not found' }, 404);
    }
    const obj = await getObject(c.env, key);
    if (!obj) return c.json({ error: 'not found' }, 404);
    return new Response(await obj.arrayBuffer(), {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'audio/mpeg',
        'cache-control': 'private, max-age=86400',
        'accept-ranges': 'bytes',
      },
    });
  });

  /** 普通网页/抖音链接预览：只抓标题和描述，限制内网地址。 */
  app.get('/api/app/web-preview', requireApp, async (c) => {
    const raw = c.req.query('url') ?? '';
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return c.json({ error: 'invalid url' }, 400);
    }
    if (!/^https?:$/.test(target.protocol)) return c.json({ error: 'invalid protocol' }, 400);
    const host = target.hostname.toLowerCase();
    if (
      host === 'localhost' || host.endsWith('.local') ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) ||
      host === '[::1]'
    ) {
      return c.json({ error: 'private host' }, 400);
    }
    try {
      const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36';
      const response = await fetch(target.toString(), {
        headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
      });
      const html = (await response.text()).slice(0, 2_000_000);
      const meta = (name: string): string => {
        const a = html.match(new RegExp(
          `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`,
          'i',
        ));
        const b = html.match(new RegExp(
          `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`,
          'i',
        ));
        return a?.[1] ?? b?.[1] ?? '';
      };
      const title = (meta('og:title') || html.match(/<title>([^<]+)<\/title>/i)?.[1] || '')
        .replace(/\s+/g, ' ').trim().slice(0, 200);
      const description = (meta('og:description') || meta('description') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 500);
      return c.json({
        title,
        description,
        site: target.hostname,
        douyin: /douyin\.com$/i.test(host),
      });
    } catch {
      return c.json({ error: 'preview failed' }, 502);
    }
  });

  /** B 站短链/视频链接预览：只允许 B 站域名，避免变 SSRF。 */
  app.get('/api/app/link-preview', requireApp, async (c) => {
    try {
      const raw = c.req.query('url') ?? '';
      if (!/^https?:\/\/(?:b23\.tv|(?:www\.)?bilibili\.com)\//i.test(raw)) {
        return c.json({ error: 'unsupported url' }, 400);
      }
      const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36';
      let target = raw;
      if (/b23\.tv/i.test(raw)) {
        const redirect = await fetch(raw, { redirect: 'follow', headers: { 'User-Agent': ua } });
        target = redirect.url;
      }
      const m = target.match(/\/video\/(BV[0-9A-Za-z]+)/i) ??
        target.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
      if (!m) return c.json({ error: 'not a video url', target }, 404);
      const bvid = m[1];
      let title = '';
      let owner = '';
      let duration = 0;
      let desc = '';
      let aid = 0;
      let cid = 0;
      let upMid = 0;
      let cover = '';
      const cookie: Record<string, string> = c.env.BILIBILI_SESSDATA
        ? { Cookie: `SESSDATA=${c.env.BILIBILI_SESSDATA}` }
        : {};
      try {
        const api = await fetch(
          `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
          {
            headers: {
              'User-Agent': ua,
              Referer: 'https://www.bilibili.com/',
              Accept: 'application/json',
              ...cookie,
            },
          },
        );
        const text = await api.text();
        if (text.trim().startsWith('{')) {
          const json = JSON.parse(text) as {
            code?: number;
            data?: {
              title?: string;
              desc?: string;
              duration?: number;
              aid?: number;
              cid?: number;
              pic?: string;
              owner?: { name?: string; mid?: number };
              pages?: Array<{ cid?: number }>;
            };
          };
          if (json.code === 0 && json.data) {
            title = json.data.title || '';
            owner = json.data.owner?.name || '';
            duration = json.data.duration || 0;
            desc = (json.data.desc || '').replace(/\s+/g, ' ').trim().slice(0, 500);
            aid = Number(json.data.aid || 0);
            cid = Number(json.data.cid || json.data.pages?.[0]?.cid || 0);
            upMid = Number(json.data.owner?.mid || 0);
            cover = (json.data.pic || '').replace(/^http:/, 'https:');
          }
        }
      } catch {
        // API 被 WAF 拦截时走页面 meta 兜底
      }
      if (!title) {
        try {
          const page = await fetch(target, {
            headers: { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' },
          });
          const html = await page.text();
          const meta = (name: string): string => {
            const a = html.match(new RegExp(
              `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`,
              'i',
            ));
            const b = html.match(new RegExp(
              `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`,
              'i',
            ));
            return a?.[1] ?? b?.[1] ?? '';
          };
          title = meta('og:title') || meta('title');
          owner = meta('author') || meta('og:site_name') || '';
          desc = (meta('og:description') || meta('description')).replace(/\s+/g, ' ').trim().slice(0, 500);
          duration = Number(html.match(/"duration":(\d+)/)?.[1] ?? 0) || 0;
          if (!title) {
            const t = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '';
            title = t.replace(/_哔哩哔哩.*$/i, '').trim();
          }
        } catch {
          // 保留空标题，App 显示短链兜底
        }
      }
      if (!title || /出错啦|页面不存在|404/i.test(title)) {
        return c.json({ error: 'preview unavailable', bvid }, 502);
      }

      let summary = '';
      let outline: string[] = [];
      let subtitle = '';
      let subtitleCount = 0;
      if (cookie.Cookie && cid) {
        const headers = {
          'User-Agent': ua,
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json',
          ...cookie,
        };
        const mixinKey = await biliMixinKey(headers);
        if (mixinKey) {
          try {
            const params = biliSign({ aid, cid }, mixinKey);
            const player = await fetch(
              `https://api.bilibili.com/x/player/wbi/v2?${params}`,
              { headers },
            );
            const pj = await player.json() as {
              data?: { subtitle?: { subtitles?: Array<{ lan?: string; subtitle_url?: string }> } };
            };
            const subs = pj.data?.subtitle?.subtitles ?? [];
            const zh = subs.find((s) => /^(zh|ai)/i.test(s.lan ?? '')) ?? subs[0];
            if (zh?.subtitle_url) {
              const url = zh.subtitle_url.startsWith('//') ? `https:${zh.subtitle_url}` : zh.subtitle_url;
              const sr = await fetch(url, { headers });
              const sj = await sr.json() as { body?: Array<{ content?: string }> };
              const lines = (sj.body ?? []).map((x) => (x.content ?? '').trim()).filter(Boolean);
              subtitleCount = lines.length;
              subtitle = lines.join('\n');
            }
          } catch {
            // 字幕不可用时继续
          }
          try {
            const params = biliSign({ bvid, cid, up_mid: upMid }, mixinKey);
            const conclusion = await fetch(
              `https://api.bilibili.com/x/web-interface/view/conclusion/get?${params}`,
              { headers },
            );
            const cj = await conclusion.json() as {
              data?: {
                model_result?: {
                  summary?: string;
                  outline?: Array<{ title?: string; part_outline?: string[] }>;
                };
              };
            };
            const model = cj.data?.model_result;
            summary = (model?.summary ?? '').trim();
            for (const item of model?.outline ?? []) {
              const t = (item.title ?? '').trim();
              if (t) outline.push(t);
              for (const p of (item.part_outline ?? []).slice(0, 4)) {
                if (p.trim()) outline.push(`  · ${p.trim()}`);
              }
              if (outline.length >= 12) break;
            }
            outline = outline.slice(0, 12);
          } catch {
            // 官方总结不可用时用简介兜底
          }
        }
      }
      return c.json({
        bvid,
        title,
        owner,
        duration,
        desc,
        summary: summary || desc,
        outline,
        subtitle,
        subtitle_count: subtitleCount,
        cover,
      });
    } catch (e) {
      return c.json({ error: 'link preview failed', detail: String(e).slice(0, 200) }, 500);
    }
  });

  /**
   * App 图片回放：设备 Token 鉴权，只允许 images/ 前缀。
   */
  /** App 视频/GIF 上传：原文件进 R2，聊天里只存 [视频:key]/[GIF:key]。 */
  app.post('/api/app/upload/video', requireApp, async (c) => {
    const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const allowed: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/3gpp': '3gp',
      'image/gif': 'gif',
    };
    const ext = allowed[mime];
    if (!ext) return c.json({ error: 'unsupported media type' }, 415);
    const length = Number(c.req.header('content-length') ?? 0);
    if (!length || length > 60 * 1024 * 1024) return c.json({ error: 'media too large' }, 413);
    const kind = ext === 'gif' ? 'gifs' : 'videos';
    const date = new Date().toISOString().slice(0, 10);
    const key = `${kind}/${date}/${crypto.randomUUID()}.${ext}`;
    const bytes = await c.req.arrayBuffer();
    await c.env.R2.put(key, bytes, {
      httpMetadata: { contentType: mime, cacheControl: 'private, max-age=31536000' },
    });
    return c.json({ key, contentType: mime, size: bytes.byteLength });
  });

  /** App 视频/GIF 回放：设备 Token 鉴权，只允许 videos/、gifs/。 */
  app.get('/api/app/media', requireApp, async (c) => {
    const key = c.req.query('key') ?? '';
    if (!/^(videos|gifs)\//.test(key) || key.length > 200 || key.includes('..')) {
      return c.json({ error: 'not found' }, 404);
    }
    const head = await c.env.R2.head(key);
    if (!head) return c.json({ error: 'not found' }, 404);
    const size = head.size;
    const etag = head.httpEtag;

    // 内容不可变（key 里带日期和 uuid），命中 ETag 直接 304，省掉整段重传。
    if (etag && c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const range = parseByteRange(c.req.header('range'), size);
    if (range === 'invalid') {
      // 416 必须带 Content-Range: bytes */size，播放器据此回到整段重取。
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
      });
    }
    const obj = await c.env.R2.get(
      key,
      range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
    );
    if (!obj) return c.json({ error: 'not found' }, 404);
    const headers: Record<string, string> = {
      'content-type': head.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-length': String(range ? range.end - range.start + 1 : size),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
    };
    if (etag) headers.etag = etag;
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
    return new Response(obj.body, { status: range ? 206 : 200, headers });
  });

  app.get('/api/app/image', requireApp, async (c) => {
    const key = c.req.query('key') ?? '';
    if (!key.startsWith('images/') || key.length > 200) return c.json({ error: 'not found' }, 404);
    const obj = await getObject(c.env, key);
    if (!obj) return c.json({ error: 'not found' }, 404);
    return new Response(await obj.arrayBuffer(), {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=86400',
      },
    });
  });

  /** App 读取云端语音配置（多设备一致）。 */
  app.get('/api/app/tts-config', requireApp, async (c) => {
    const config = await loadTtsConfig(c.env);
    return c.json({ ok: true, config });
  });

  /** App 上传语音配置：设置变了就同步一次，网页也用这份。 */
  app.post('/api/app/tts-config', requireApp, async (c) => {
    const body = await c.req.json().catch(() => null);
    const config = await saveTtsConfig(c.env, body);
    return c.json({ ok: true, config });
  });

  /** 网页合成语音：走云端配置 + R2 缓存，声音和 App 一致。 */
  app.post('/api/tts/speak', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; style?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 1200) : '';
    if (!text) return c.json({ error: 'text 不能为空' }, 400);
    const style = typeof body?.style === 'string' ? body.style.replace(/[^a-z]/gi, '') : undefined;
    try {
      const { key, audio, cached } = await speakWithCache(c.env, text, { style });
      return new Response(audio, {
        headers: {
          'content-type': 'audio/mpeg',
          'cache-control': 'private, max-age=86400',
          'x-tts-cache': cached ? 'hit' : 'miss',
          // 网页拿到 key 后直接用 /api/audio/<key> 播放，省一次大响应体
          'x-tts-key': key,
        },
      });
    } catch (e) {
      console.error('[tts] speak failed:', e);
      return c.json({ error: 'tts failed' }, 502);
    }
  });

  /** 网页读取当前语音配置（用于显示，不含密钥）。 */
  app.get('/api/tts/config', requireAuth, async (c) => {
    return c.json({ ok: true, config: await loadTtsConfig(c.env) });
  });

  /**
   * App 状态页：心情 / 关系 / 记忆 / 今天 / 余额。
   * 刻意只回模糊的一句话，不回 0-100 的数值。
   */
  app.get('/api/app/status', requireApp, async (c) => {
    const snapshot = await getStatusSnapshot(c.env);
    return c.json(snapshot);
  });

  /**
   * App TTS 代理：手机直连 eastus 实测 20s+，改走 Worker 边缘节点。
   * 设备 Token 鉴权；只接受短文本，避免变成公开 TTS。
   */
  app.post('/api/app/tts', requireApp, async (c) => {
    const body = await c.req.json().catch(() => null) as {
      text?: unknown;
      voice?: unknown;
      rate?: unknown;
      pitch?: unknown;
      style?: unknown;
      style_degree?: unknown;
    } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 2000) return c.json({ error: 'text invalid' }, 400);
    const key = c.env.AZURE_SPEECH_KEY;
    if (!key) return c.json({ error: 'tts not configured' }, 503);
    const region = (c.env.AZURE_SPEECH_REGION || 'eastus').replace(/[^a-z0-9-]/gi, '');
    const voice = typeof body?.voice === 'string' && /^[A-Za-z0-9-]+$/.test(body.voice)
      ? body.voice
      : 'zh-CN-XiaoyiNeural';
    const rate = typeof body?.rate === 'string' ? body.rate.replace(/[^0-9%+-]/g, '') : '+5%';
    const pitch = typeof body?.pitch === 'string' ? body.pitch.replace(/[^0-9%+\-Hz]/g, '') : '+3Hz';
    const style = typeof body?.style === 'string' ? body.style.replace(/[^a-z]/gi, '') : '';
    const degree = typeof body?.style_degree === 'string'
      ? body.style_degree.replace(/[^0-9.]/g, '')
      : '1.2';
    const escape = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&apos;')
      .replace(/"/g, '&quot;');
    const inner = `<prosody rate='${escape(rate)}' pitch='${escape(pitch)}'>${escape(text)}</prosody>`;
    const content = style
      ? `<mstts:express-as style='${style}' styledegree='${escape(degree)}'>${inner}</mstts:express-as>`
      : inner;
    const ssml = `<speak version='1.0' xml:lang='zh-CN' xmlns:mstts='https://www.w3.org/2001/mstts'><voice xml:lang='zh-CN' name='${escape(voice)}'>${content}</voice></speak>`;
    const upstream = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'DS-Mobile-Worker',
        },
        body: ssml,
      },
    );
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      return c.json({ error: 'tts upstream failed', status: upstream.status, detail }, 502);
    }
    return new Response(await upstream.arrayBuffer(), {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'no-store',
      },
    });
  });

  /** 聊天图片回放（需登录；图片存在 R2 images/ 下，主账号优先、小号兜底）。 */
  app.get('/api/image/*', requireAuth, async (c) => {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/image\//, ''));
    if (!key.startsWith('images/')) return c.json({ error: 'not found' }, 404);
    const obj = await getObject(c.env, key);
    if (!obj) return c.json({ error: 'not found' }, 404);
    return new Response(await obj.arrayBuffer(), {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=86400',
      },
    });
  });

  /** 增量拉取（实时刷新用）：?after_id=<已知最大编号>&limit=50，升序返回比它新的消息。
   *  前端定时轮询此接口，实现 QQ / 其它渠道消息在网页端“实时出现”。
   */
}
