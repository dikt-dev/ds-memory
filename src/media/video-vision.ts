/**
 * 视频理解：把一段视频交给千问 omni，换回一份「带时间点的观察笔记」。
 *
 * 她的脑子是 DeepSeek，看不了视频。这里做的事就是把视频翻译成它能读的文字：
 * 谁在做什么、画面里有什么字、说了什么话。写得好不好，直接决定她回得像不像看过。
 *
 * 模型选 qwen3.8-omni-flash：实测 10 秒视频 2.6 秒出结果、662 video tokens，
 * 而且能同时听声音（whisper 那条路可以不用了）。
 */

const PROMPT = [
  '你是视频观察员。你的输出会给另一个助手看，她没看过这段视频。',
  '',
  '规则：',
  '1. 按时间顺序写发生了什么，每行以「秒数 描述」开头。动作要具体：谁、做了什么、手里拿着什么、表情怎么变。',
  '2. 画面里出现的文字（招牌、屏幕上的字、字幕）原样抄下来，写在出现的那个时间点上。',
  '3. 有人说话就逐字写下来，带时间点，用「说：」引出；听不清写「听不清」。',
  '4. 不要总结成一句话，不要用「视频展示了」这类套话，不要评价好坏。',
  '5. 只写你确实看到、听到的；没出现的东西不要推测。',
  '',
  '输出纯文本，不要 markdown 代码块。',
].join('\n');

export interface VideoObservation {
  text: string;
  ms: number;
  cached: boolean;
  model: string;
}

function endpoint(env: { DASHSCOPE_BASE_URL?: string }): string {
  const base = env.DASHSCOPE_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return base.replace(/\/$/, '') + '/chat/completions';
}

/** 调一次模型看视频；失败抛错，由调用方决定降级。 */
export async function lookAtVideo(
  env: { DASHSCOPE_API_KEY?: string; DASHSCOPE_VL_MODEL?: string; DASHSCOPE_BASE_URL?: string; KV: KVNamespace },
  videoUrl: string,
  opts: { cacheKey?: string; timeoutMs?: number } = {},
): Promise<VideoObservation> {
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY 未配置');
  const model = env.DASHSCOPE_VL_MODEL?.trim() || 'qwen3.8-omni-flash';
  const cacheKey = opts.cacheKey ? `vobs:${opts.cacheKey}` : '';

  if (cacheKey) {
    const hit = await env.KV.get(cacheKey).catch(() => null);
    if (hit) return { text: hit, ms: 0, cached: true, model };
  }

  const started = Date.now();
  const res = await fetch(endpoint(env), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'video_url', video_url: { url: videoUrl } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
      max_tokens: 1200,
      enable_thinking: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });

  const payload = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
    | null;
  if (!res.ok) {
    const detail = payload?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`视频理解失败：${detail}`);
  }
  const text = (payload?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('视频理解返回空内容');

  if (cacheKey) await env.KV.put(cacheKey, text, { expirationTtl: 14 * 24 * 3600 }).catch(() => {});
  return { text, ms: Date.now() - started, cached: false, model };
}
