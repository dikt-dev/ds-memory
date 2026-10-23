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
  DISTILL_DEEPSEEK_MODEL: string; // 每日提炼/压缩使用的 DeepSeek 模型（默认 v4-pro，质量优先）
  SUMMARY_DEEPSEEK_MODEL: string; // 滚动摘要使用的 DeepSeek 模型（默认 flash，成本优先）
  MEMORY_REFRESH_BYTES: string; // 字符串，使用处 Number() 解析
  MEMORY_TRIM_BYTES: string;
  // DeepSeek 计费单价（高峰时段，元/百万 tokens；闲时自动减半）
  PRICE_INPUT_HIT_PEAK: string;
  PRICE_INPUT_MISS_PEAK: string;
  PRICE_OUTPUT_PEAK: string;
  // ── 角色身份（部署方可覆盖，开源默认值见 src/identity.ts）──
  CHARACTER_NAME?: string; // 角色自称：缺省为「小忆」，可自行改（见 src/identity.ts）
  USER_ADDRESS?: string;  // 期望对方怎么称呼自己：缺省按记忆自然称呼

  // secrets（可选：未配置时对应功能降级）
  DEEPSEEK_API_KEY?: string;
  ACCESS_PASSWORD_HASH?: string;
  ASTROBOT_API_KEY?: string; // OpenAI 兼容端点（AstrBot 等）的 Bearer 密钥
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
