/**
 * Worker 绑定与环境变量类型。
 * 与 wrangler.toml 一一对应；secrets 在本地开发时由 .dev.vars 注入。
 */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;

  // vars
  CITY: string;
  LATITUDE: string;
  LONGITUDE: string;
  DEEPSEEK_MODEL: string;
  DISTILL_MODEL: string;
  DISTILL_DEEPSEEK_MODEL: string; // 每日提炼使用的 DeepSeek 模型（默认 v4-pro，质量优先）
  SUMMARY_DEEPSEEK_MODEL: string; // 滚动摘要使用的 DeepSeek 模型（默认 flash，成本优先）
  EMBEDDING_MODEL?: string; // 记忆检索语义向量模型（默认 @cf/baai/bge-m3；缺失/失败自动降级关键词召回）
  SELF_REVIEW?: string; // 'on' 开启每夜自审（只执行 A 档动作，默认关）
  MEMORY_PROMPT_MODE?: string; // 'evidence' 只注入宪法四节，其余靠召回（默认 full）
  MEMORY_SNAPSHOT?: string; // 'off' 关闭每日记忆快照（默认开启，见 docs/memory-rollback-plan.md）
  LLM_RERANK?: string; // 条件 LLM 重排开关：默认开，设 '0' 关闭（省一次调用的延迟）
  REQUEST_LOG?: string; // 'off' 关闭请求级 trace 落 D1（默认开，见 src/request-log.ts）
  AI_LIFE?: string; // 'off' 强制关闭生活系统（P2 闸门总开关；默认由 KV life:enabled 决定）
  // DeepSeek 计费单价（高峰时段，元/百万 tokens；闲时自动减半）
  PRICE_INPUT_HIT_PEAK: string;
  PRICE_INPUT_MISS_PEAK: string;
  PRICE_OUTPUT_PEAK: string;
  // ── 角色身份（部署方可覆盖，开源默认值见 src/identity.ts）──
  CHARACTER_NAME?: string; // 角色自称：缺省为「小忆」，可自行改（见 src/identity.ts）
  USER_ADDRESS?: string;
  /** 人设：自称（默认「本小姐」） */
  PERSONA_SELF_CALL?: string;
  /** 人设：关系定位（默认「他的专属 AI 女友」） */
  PERSONA_ROLE?: string;
  /** 人设：固定称呼后的说明句 */
  PERSONA_ADDRESS_NOTE?: string;
  /** 人设语气：auto 按亲密度 / peer 损友式一开始就放松 */
  PERSONA_TONE?: string;
  /** 人设：她自己的长相（照片/视频里认出「这是我」用） */
  PERSONA_LOOK?: string;
  /** none = 提示词里一句人设都不下发（清空重置/换人设的窗口期） */
  PERSONA_PROFILE?: string;  // 期望对方怎么称呼自己：缺省按记忆自然称呼

  // secrets（可选：未配置时对应功能降级）
  DEEPSEEK_API_KEY?: string;
  ACCESS_PASSWORD_HASH?: string;
  /** 无状态鉴权签名密钥；缺失时回退 ACCESS_PASSWORD_HASH（不推荐长期使用）。 */
  AUTH_SECRET?: string;
  /** 鉴权模式：signed（默认）| kv（回滚用）。 */
  AUTH_MODE?: string;
  /** 记忆引擎：legacy（默认）| shadow（只记录）| next（使用新召回）。 */
  MEMORY_ENGINE?: string;
  /** 态度引擎：legacy（默认）| shadow（只记录）| next（使用 attitude policy）。 */
  AFFECT_ENGINE?: string;
  MEMORY_ENGINE_QQ?: string;
  MEMORY_ENGINE_WEB?: string;
  MEMORY_ENGINE_MOBILE?: string;
  AFFECT_ENGINE_QQ?: string;
  AFFECT_ENGINE_WEB?: string;
  AFFECT_ENGINE_MOBILE?: string;
  /** 主动消息引擎：legacy（默认）| shadow（只记录）| next（使用新记忆/态度）。 */
  PROACTIVE_ENGINE?: string;
  /** 主动消息投递：queue（旧）| events（App 从 /api/app/events 收） */
  PROACTIVE_DELIVERY?: string;
  ASTROBOT_API_KEY?: string; // OpenAI 兼容端点（AstrBot 等）的 Bearer 密钥
  /** Azure Speech TTS；App 通过 Worker 代理避免手机直连 Azure 的高延迟 */
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
  /** B 站登录 Cookie 里的 SESSDATA；用于取视频简介/总结 */
  BILIBILI_SESSDATA?: string;
  /** DS-Mobile 一次性配对码；留空则临时复用 ASTROBOT_API_KEY */
  APP_PAIR_CODE?: string;
  // 小号 R2（S3 兼容 API）：主账号容量达到阈值后，新数据写入小号
  SECONDARY_R2_ACCOUNT_ID?: string;
  SECONDARY_R2_BUCKET?: string;
  SECONDARY_R2_ACCESS_KEY_ID?: string;
  SECONDARY_R2_SECRET_ACCESS_KEY?: string;
  // 主账号 R2 容量阈值（字节，字符串）
  STORAGE_THRESHOLD_BYTES: string;
  // 主动消息（AstrBot HTTP API）：留空则关闭该功能
  ASTRBOT_BASE_URL: string;
  ASTRBOT_UMO: string;
  // 主动消息强度：quiet=少说 / normal=正常 / active=活跃
  PROACTIVE_LEVEL: string;
  // AstrBot OpenAPI Key（secret）
  ASTROBOT_OPENAPI_KEY?: string;
}

/** Hono 的绑定与请求变量类型（原来定义在 index.ts 里，路由拆分后共享）。 */
export type AppEnv = { Bindings: Env; Variables: { requestId: string } };
