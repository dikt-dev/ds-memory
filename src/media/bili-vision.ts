/**
 * B 站视频理解：不下载、不落 R2，直接把 CDN 直链丢给千问 omni。
 *
 * 实测（2026-11）：页面链接给 omni 会报 "Failed to download multimodal content"，
 * 但 playurl 拿到的 bilivideo.com 直链能匿名拉取，9.9 秒就看完一段 200 秒的视频。
 * 所以这里只做三件事：查 bvid→cid、拿直链、交给 omni。
 *
 * 直链带签名和时效（约两小时），必须现取现用，不能缓存到 KV 里过夜。
 */
import { lookAtVideo } from './video-vision';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const BILI_URL_RE = /https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i;

const PROMPT = [
  '你在看一条 B 站视频。你的输出会给另一个助手看，她没看过这条视频。',
  '',
  '规则：',
  '1. 按时间顺序写画面里发生了什么，每行以「秒数 描述」开头。动作要具体。',
  '2. 画面里的文字（标题、字幕、屏幕上的字、招牌）原样抄下来。',
  '3. 有人说话就写他说了什么，带时间点。',
  '4. 不要总结成一句话，不要评价，不要复述标题。',
  '5. 必须写到视频最后一秒：时间不够就前面细写（逐秒），两分钟之后按每 10 秒一段粗写，最后一行要落在结束处。',
  '输出纯文本，不要 markdown。',
].join('\n');

interface BiliView {
  title: string;
  duration: number;
  cid: number;
  bvid: string;
}

async function viewInfo(bvid: string): Promise<BiliView | null> {
  const api = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const res = await fetch(api, {
    referrer: 'https://www.bilibili.com/',
    headers: { 'user-agent': UA },
  } as unknown as RequestInit);
  if (!res.ok) return null;
  const json = (await res.json()) as {
    code?: number;
    data?: { title?: string; duration?: number; cid?: number; bvid?: string };
  };
  const d = json.data;
  if (json.code !== 0 || !d?.cid) return null;
  return {
    title: (d.title ?? '').trim(),
    duration: d.duration ?? 0,
    cid: d.cid,
    bvid: d.bvid ?? bvid,
  };
}

/** 取可直接播放的 mp4 直链（html5 平台 + durl 单文件，通常是 360P）。 */
async function directUrl(bvid: string, cid: number): Promise<string | null> {
  for (const qn of [32, 16]) {
    const api =
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=1&platform=html5`;
    const res = await fetch(api, {
      referrer: 'https://www.bilibili.com/',
      headers: { 'user-agent': UA },
    } as unknown as RequestInit);
    if (!res.ok) continue;
    const json = (await res.json()) as { code?: number; data?: { durl?: Array<{ url?: string }> } };
    const url = json?.data?.durl?.[0]?.url;
    if (json.code === 0 && url) return url;
  }
  return null;
}

export interface BiliVision {
  title: string;
  duration: number;
  text: string;
  ms: number;
  cached: boolean;
}

/** 看完一条 B 站视频。失败返回 null，调用方保留现有的雪碧图/大纲卡片。 */
/**
 * 看完一条 B 站视频（直链由手机端提供，服务端不碰 B 站接口）。
 *
 * 为什么不让服务端自己取直链：机房 IP 拉 api.bilibili.com 会被 412；
 * 而手机端本来就有 cookie 和正常 IP，取直链是它已经在做的事。
 * 拿到直链以后交给模型，模型那边能直接拉 bilivideo.com 的 CDN（实测 200）。
 */
export async function biliVisionDirect(
  env: { DASHSCOPE_API_KEY?: string; DASHSCOPE_VL_MODEL?: string; KV: KVNamespace },
  input: { direct: string; title?: string; duration?: number; cacheKey?: string; bvid?: string; cid?: number },
  castHint?: string,
): Promise<BiliVision | null> {
  if (!env.DASHSCOPE_API_KEY) return null;
  const cacheKey = input.cacheKey ? `biliobs:v3:${input.cacheKey}` : '';
  if (cacheKey) {
    const hit = await env.KV.get(cacheKey).catch(() => null);
    if (hit) {
      return { title: input.title ?? '', duration: input.duration ?? 0, text: hit, ms: 0, cached: true };
    }
  }
  // ★ 手机端带 Cookie 取直链时，B 站会返回 PCDN 节点（*.solseed.cn / *.edge.mountaintoys.cn），
  //   千问 omni 拉不动，800ms 就报 "Failed to download multimodal content"。
  //   2026-11-10：不再直接判死——先让服务端自己按 html5 参数再要一条直链（那条一般落在
  //   *.bilivideo.com），拿到就继续；实在拿不到才记错误返回。
  const isCdnHost = (u: string) => {
    const h = (() => { try { return new URL(u).host; } catch { return ''; } })();
    return /\.bilivideo\.com$/.test(h) || /\.hdslb\.com$/.test(h);
  };
  let direct = input.direct;
  if (!isCdnHost(direct)) {
    const host = (() => { try { return new URL(direct).host; } catch { return ''; } })();
    const bvid = (input.bvid ?? '').trim() || /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(input.cacheKey ?? '')?.[1] || '';
    const cid = Number(input.cid ?? 0) || 0;
    const fallback = bvid && cid > 0 ? await directUrl(bvid, cid).catch(() => null) : null;
    if (fallback && isCdnHost(fallback)) {
      direct = fallback;
      await env.KV.put('bili:vision:fallback', JSON.stringify({ at: Date.now(), from: host, to: new URL(fallback).host }), { expirationTtl: 7 * 86400 }).catch(() => {});
    } else {
      await env.KV.put('bili:vision:last_error', JSON.stringify({ at: Date.now(), error: 'PCDN 直链模型拉不到，兜底也失败', host, bvid, cid }), { expirationTtl: 7 * 86400 }).catch(() => {});
      throw new Error('PCDN 直链模型拉不到：' + host);
    }
  }
  try {
    const obs = await lookAtVideo(env, direct, {
      prompt: [
        PROMPT,
        castHint
          ? `\n【已知角色】\n${castHint}\n认人规则：先看发色再认（蓝发=${'小蓝'}/你本人，橙发=小克，白发+龙角=大白龙）；耳朵、尾巴、发饰对得上就写名字，服装换了也算。\n只在特征明显对得上时写名字；背景里模糊、只闪一两秒的人写「几个看不清的人」，不要硬认。`
          : '',
        '',
        input.title ? `【视频标题】${input.title}` : '',
        input.duration ? `【时长】${input.duration} 秒` : '',
      ].filter(Boolean).join('\n'),
      // 900 token 只够写两分半：7 分钟的视频会被砍在半句话上（2026-11-07）
      maxTokens: Math.min(4000, 700 + Math.round((input.duration ?? 60) * 6)),
      timeoutMs: 120_000,
    });
    if (cacheKey) await env.KV.put(cacheKey, obs.text, { expirationTtl: 30 * 24 * 3600 }).catch(() => {});
    // 成功时间留痕：聊天侧靠它判断「最近那条到底看没看成」
    await env.KV.put('bili:vision:last_ok', JSON.stringify({ at: Date.now(), title: input.title ?? '' }), { expirationTtl: 3 * 86400 }).catch(() => {});
    return {
      title: input.title ?? '',
      duration: input.duration ?? 0,
      text: obs.text,
      ms: obs.ms,
      cached: obs.cached,
    };
  } catch (e) {
    const host = (() => { try { return new URL(direct).host; } catch { return ''; } })();
    await env.KV.put('bili:vision:last_error', JSON.stringify({ at: Date.now(), error: String(e).slice(0, 300), host }), { expirationTtl: 7 * 86400 }).catch(() => {});
    return null;
  }
}

/**
 * 「最近那条视频没看成」——当成一条事实给她（2026-11-11）。
 *
 * 失败以前只写进 KV 的 last_error，聊天侧看不到；她拿到标题和简介，
 * 就会自己补一个「我看过了」。这里把缺口补成一句明确的旁白。
 */
export async function videoFailNote(
  env: { KV: KVNamespace },
): Promise<string | null> {
  const [failRaw, okRaw] = await Promise.all([
    env.KV.get('bili:vision:last_error').catch(() => null),
    env.KV.get('bili:vision:last_ok').catch(() => null),
  ]);
  if (!failRaw) return null;
  const fail = (() => { try { return JSON.parse(failRaw) as { at?: number; host?: string } } catch { return null } })();
  if (!fail?.at || Date.now() - fail.at > 24 * 3600_000) return null;
  const ok = (() => { try { return JSON.parse(okRaw ?? 'null') as { at?: number } | null } catch { return null } })();
  if (ok?.at && ok.at > fail.at) return null; // 之后已经看成了，别再提醒
  return '【视频】最近那条视频你没解析出画面，只看得到标题和简介。别描述里面的镜头和结尾，说没点开看就行。';
}

/** 供 App 拼卡片：把画面过程写成 [BILI_META] 里的一段。 */
export function biliVisionSection(v: BiliVision): string {
  return ['## 画面过程（按时间）', v.text.trim(), ''].join('\n');
}
