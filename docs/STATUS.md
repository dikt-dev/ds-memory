# 项目现状（2026-10-31）

> 本文是"现在到底什么样"的单页快照。历史细节看 `docs/TASKS.md`，自主记忆改造的边界与清单看 `docs/AUTONOMY-PLAN.md`。

## 一、两个仓库

| | ds-memory（引擎） | ds-mobile（客户端） |
| --- | --- | --- |
| 技术栈 | Cloudflare Workers + Hono + TS ESM；D1 / KV / R2 / Workers AI / DeepSeek | Kotlin + Compose、Room、OkHttp、AlarmManager |
| 线上 | `https://fae.us.ci` | release APK 56.36 MB（R8） |
| 当前版本 | `3c37d2e8` | commit `d8171b3` |
| 代码规模 | 111 个源文件 / 25608 行（index.ts 1629 → 651） | ChatActivity 1245 行、ApiClient 1049 行 |
| 质量 | **1092 个测试 / 101 个文件全绿**，`tsc --noEmit` 干净 | 无单测基建，靠编译 + 真机验证 |
| 协议 | 私有部署 | Apache-2.0（LICENSE + README 已就位） |

## 二、运行开关

```
MEMORY_ENGINE      = next       # 召回走新引擎
MEMORY_PROMPT_MODE = evidence   # 提示词只带宪法四节
SELF_REVIEW        = on         # 每夜自审（只 A 档动作）
MEMORY_SNAPSHOT    = 默认开      # 每日快照 + 一键回滚
```

回滚口径：前两个改回 `legacy` / `full`；自审删掉 `SELF_REVIEW` 那一行。

## 三、数据现状

| 项 | 数值 |
| --- | --- |
| 消息 | 136 条（测试污染已清） |
| 长期记忆 memory.md | 12 744 B → 提示词 2 327 B（降 82%） |
| 事实 / 片段 / 事件 / 关系链 | 43 / 94 / 14 / 210 |
| 当前失效事实 | 0（机制验证过，真实冲突尚未发生） |
| 自主动作（审计表） | 7 条，全部可撤销 |
| 召回样本 | 269 |

## 四、质量指标

- **健康分 94.16 / good**：命中率 99%、超时 0.37%、失忆抱怨 0/67 条
- 召回延迟：p50 1407 ms / p95 2287 ms（仍混有 shadow 期样本；next 纯样本 961–1106 ms）
- 评估集：next **91/97（93.8%）**，旧链路 84/97，误召 0
- 引文逐字率 **32/32 = 100%**

## 五、记忆分层

```
宪法（人物底色 / 称呼与关系 / 雷区与禁忌 / 用户更正）  → 每轮注入 2 327 B
L0 原文 messages                                   → 只追加，永不改
L1 facts / events                                  → 带出处、置信度、valid_to 失效链
L2 chunks / 向量 / 关系链                           → 94 片段、210 链路，可重建
L3 每轮工作记忆                                     → 宪法 + 召回证据 + 关系状态
旁路：facts.md（只读白皮书，不进提示词）/ self-check / self-review / persona-drift
```

## 六、已完成的能力

- **记忆**：每日提炼、事件级抽取（引文逐字校验）、分层召回（legacy/next）、关系链扩展、摘要滚动、快照与一键回滚
- **情绪**：情绪向量、结算补算、委屈降权、历史留档
- **自主**：写闸口（6 条不变量 / 3 档权限）、动作审计、事实失效链、置信度、证据门、证据集注入、健康分、每夜自检、自审 agent、B 档变体裁决、人格指纹、facts.md 投影
- **客户端**：主动唤醒守卫（醒太早就不请求）、诊断页、B 站/图片/语音链路、R8 发布包

## 七、待办与观察

| 项 | 状态 |
| --- | --- |
| S3 注入可追溯（记录注入的 fact id 集合） | 未做；S6 后收益下降 |
| 长视频取帧上限 | 按用户意思不做 |
| ApiClient 再拆分（引入 internal Http 持有者） | 待做，属大重构 |
| 今晚 04:00 第一次自动自审 | 等结果 |
| 人格指纹基线 | 前 7 天无数据，需攒两周 |
| 失效链的真实冲突 | 机制就绪，等真实发生 |
| R8 下 media3 / ML Kit 长期表现 | 观察中 |

## 八、本次代码审查发现

按优先级列，前两条已在本轮修掉。

### 已修

1. **逐条 await 的批量写**（`fact-expiry.applyExpiry`、`self-check` 的两处降权）
   D1 上每条 UPDATE 都是一次往返，事实一多就成瓶颈。改成 `env.DB.batch()` 一次发完。
2. **热表缺索引**：`memory_actions(created_at)`、`recall_samples(day_key, mode)` 都是按时间/天查询的热路径，之前全表扫。已加 `CREATE INDEX IF NOT EXISTS`。
3. **同一天重复自检会重复降权**：孤儿事实每次跑都 −0.15，手动跑三次就掉到地板。现在加了 `updated_at < now - 12h` 的门槛，一天最多降一次。

4. **三处提示词组装重复**（`chat.ts` / `openai.ts` / `webproactive.ts`）
   → **已修**：抽出 `src/context-pack.ts`（`buildMemoryPack` + `budgetFromPack` + `shouldSkipMemoryRecall`），
   三个渠道共用同一份"取记忆 → 中期/摘要二选一 → evidence 判定 → 去重 → 预算"，共删约 110 行重复代码。

### 已处理（本轮继续）

6. **静默降级**：新增 `src/degradations.ts` —— 按天把降级次数记进 D1 的 `degradation_log`，
   健康分新增「静默降级」10 分（权重改为 35/25/15/15/10）。
   已在 R2 读、KV 读、向量嵌入、自检依赖四处埋点；管理端 `GET /api/admin/memory/degradations` 看部件分布。
7. **日志非结构化**：新增 `src/error-log.ts`，`logError/logWarn` 与 `console.error` 参数形状相同，
   全库 108 处（28 个文件）已机械替换，输出固定字段 JSON（level / at / component / msg / detail）。
8. **无 LIMIT 的增长型查询**：逐条核过 15 处候选，给 11 处补了上限（messages 2000、facts 5000、
   chunks 2000、engine_metrics 2000、recall_samples 5000），其余是 `IN (...)` 由参数长度约束或聚合查询，不改。

### 仍然待办

5. **`index.ts` 1629 → 649 行**：已拆出 `routes-app.ts`（设备 Token 那一组）、`routes-proactive.ts`（队列 + 鉴权）、
   `routes-media.ts`（上传/回放/TTS/外链预览）、`queue-auth.ts`（队列与设备鉴权）。
   仍留在 index.ts 的是登录/聊天/历史/统计、静态资源兜底与 cron 入口——这些共同依赖 `app` 之外的执行上下文，暂不拆。
6. **125 处 SELECT 没有 LIMIT**：多数是聚合查询没问题，但增长型表（`messages`、`memory_event_log`）的长查询要逐个确认，避免以后数据涨了才炸。
7. **87 处 `console.error`**：日志非结构化，查问题时只能靠 grep。建议统一走 `logJob` / `logTrace` 这类带字段的出口（`log-hygiene` 守卫已经在管一部分）。
8. **10 处静默 `catch {}`**：降级是有意的（记忆挂了不能影响聊天），但至少应该计数，否则"静默退化"没人发现。可接进健康分。

## 八点五、记忆主体错位（2026-10-31 修）

现象：有些事是用户做的，她会记成自己做的。

根因在写入端压缩，不在读取：
1. 归档提示词要求「电报体、去主语」——「用户熬夜调通了 AstrBot」被压成「熬夜调通 AstrBot」，主体丢了；
2. 「共同经历」允许第一人称写法，进一步把两边动作混成「一起」；
3. 事件抽取的 summary/facts 没要求写主体。

修法（只改写入端 + 加审计，不改历史记忆）：
- `distill.ts` 新增【主语规则】：动作条目必须以「用户/她/一起」开头，拿不准归「用户」；
  「去主语」只适用于静态事实（键=值）。
- `memory-events.ts`：summary 必须写清谁做的，facts 每条以「用户」或「她」开头。
- `subject-guard.ts`：`classifyActor` / `auditSubjects` 审计「有动作但没主体」的条目，
  接入自检报告（`subjectIssues`）与 `GET /api/admin/memory/subject-audit`。
- `memory-domain.ts`：非键值条目按文本推断 `subject`（用户/她/双方），facts 投影能看到归属。

**存量已全部修完（2026-10-31）**：`POST /api/admin/memory/subject-fix?confirm=1` 一次改 14 条
（含 15 条人工审过的整行规则 + 通用"补用户"规则），改前备份到
`memory/subject-fix/<时间戳>.md`，改动记进 `memory_actions`（actor=human）。
改完 `subject-audit` 归零；旧版本投影事实用 `POST /api/admin/memory/reconcile-facts` 标失效（不删），
facts.md 里保留"已失效"历史。

审计结论：42 条记忆里 14 条主体不明或归属错（比初版的 5 条多——通用规则只抓"没主体"，
逐行读过才看得出"主体写错"的，比如"陪写插座C代码"其实是他写的）。

## 八点六、归档链路的尺寸限制（2026-10-31 放开）

原设计到处为"省字节"设上限，代价是**记忆在写进去的时候就少了**。既然 R2 有小号兜底、
token 也不再是约束，这些上限按"只做安全阀"重设：

| 位置 | 原值 | 现值 | 原值的问题 |
| --- | --- | --- | --- |
| 提炼视图·她的回复 | 400 字 | 6000 字 | 她的承诺/情绪/玩笑被砍掉，「共同经历」只剩用户半边 |
| 提炼视图·用户消息 | 3000 字 | 12000 字 | 文件块已折叠，再砍砍的是真实长叙述 |
| 单次提炼对话 | 60K 字符，超出**只留尾部** | 60K/段，超出**分段**（≤12 段） | 一天聊得多，早上的事直接不参与提炼 |
| 提炼输入总预算 | 无（记忆+对话各自定死） | 110K 字符，按记忆大小自适应 | 记忆 96KB + 对话 60K 会超 128K 上下文 |
| memory.md 常驻上限 | 24KB（超出搬 archive） | 96KB | archive 不进提示词，等于记忆被降级成"想不起来就没了" |
| 近期动态保留 | 7 天 | 30 天 | 一周后正需要想起来的事就没常驻了 |
| 快照保留 | 45 天 | 365 天 | 回滚窗口太短 |
| archive → facts 解析 | 最后 500 行 | 5000 行 | 更早的档案等于不可检索 |

## 九、风险提示

- **evidence 模式把召回变成单点依赖**：提示词只带宪法，召回没命中就是真空白。健康分里的"失忆抱怨"就是哨兵——每百条出现 3 次"你忘了"就该切回 `full` 排查。
- **她今晚开始自主改记忆**：只有 A 档、有上限、可撤销，但性质变了。建议先看几晚报告再决定长期开着。
- **测试污染流程**：任何真机测试后必须删 D1 消息并让手机"清空本地记录并重新同步"，否则本地与服务端会分叉。
