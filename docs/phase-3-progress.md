# Phase 3 完成报告：Relationship / Affect Context

> 日期：2026-10-24  
> 状态：✅ 工程门禁通过（tag `refactor-p3`；生产 7 天影子在 Phase 5 上线前）  
> 规则文档：[affect-policy.md](ds-memory/docs/affect-policy.md)

---

## 1. 目标

把 5 轴关系、8 维情绪、态度策略拆成可审计、可解释、可重置的独立上下文，同时保持默认行为不变。

---

## 2. 完成内容

### 2.1 规则与不变量

- 5 轴：`affection / trust / respect / attraction / intimacy`；
- 0–1000；单轮 ±1.5；日上限 5/4/4/4/4；
- 8 维情绪：-100–100；单轮 ±30；`grievance` 不自然衰减；
- `mood` 由情绪向量派生，不再单独维护；
- 全部规则写入 `docs/affect-policy.md`。

### 2.2 D1 账本

新增 [006-affect-context.sql](ds-memory/migrations/006-affect-context.sql)：

- `affect_events(kind=emotion|relationship, type, evidence, delta_json, confidence, created_at, resolved_at)`；
- `attitude_snapshots(archetype, attitude, directives_json, facets_json, emotion_json, policy_version, created_at)`；
- 只追加；`INSERT OR IGNORE` 防重复。

[affect-store.ts](ds-memory/src/affect-store.ts)：

- `recordEmotionEvents`：情绪事件入账；
- `recordFacetDelta`：每轮 5 轴增量入账；
- `recordAttitudeSnapshot`：保存策略快照；
- `listAffectTimeline`：解释/时间线。

`processEmotionTurn` 已在事件抽取后写入账本；失败不影响聊天。

### 2.3 态度策略

新增 [attitude-policy.ts](ds-memory/src/attitude-policy.ts)：

- `buildAttitudePolicy`：
  - 关系原型 → 基调；
  - 情绪 → 当下修饰；
  - 未化解事件 → 别急着翻篇；
  - 对方倾诉 → 先接住情绪；
  - 被冷落 → 允许小情绪，但不审问；
- 输出 `directives / reasons / safety / policy_version`；
- `text` 不含原始数值；
- `safety`：不宣称真实意识、不施加愧疚、不威胁遗弃。

开关：

| `AFFECT_ENGINE` | 行为 |
|---|---|
| `legacy`（默认） | 旧 `emotion.snapshot` |
| `shadow` | 只写 `[trace] affect.policy` |
| `next` | 用 `policy.text` 替换状态卡 |

### 2.4 解释 / 重置 / 安全

新增/扩展：

- `GET /api/admin/relation`：增加 `policy`、`timeline`、`affect_engine`；
- `GET /api/admin/affect/explain`：策略 + 原因 + 未化解事件 + 时间线 + `snapshot_id`；
- `POST /api/admin/affect/ingest`：管理端喂一条消息，真实写账本；
- `POST /api/admin/affect/reset`：
  - `scope=emotion`：清情绪运行时状态；
  - `scope=relationship` / `all`：先备份 `memory.md`，再把 5 轴重置默认；
  - 必须 `confirm=true`。

---

## 3. 验证

```text
tsc --noEmit     ✅
vitest run       53 files / 677 tests ✅
scripts/verify.sh ✅ exit 0
```

### 3.1 事件账本

本地管理端喂「你懂什么，废物」：

```text
POST /api/admin/affect/ingest
→ facets: affection 618 / trust 640 / respect 648 / attraction 320 / intimacy 480
→ timeline: 2 条
   - kind=relationship, type=facet_delta, delta={affection:-2.4, respect:-2.4}
   - kind=emotion, type=insult, evidence=你懂什么，废物
```

### 3.2 解释与快照

```text
GET /api/admin/affect/explain
→ policy_version=attitude-v1
→ archetype=natural, tone=自然
→ reasons=[委屈, 低落, 「你懂什么，废物」还没过去]
→ snapshot_id=att_...
→ timeline=2
```

### 3.3 重置

```text
POST /api/admin/affect/reset {confirm:true, scope:all}
→ backupKey=memory/backup/reset-...md

GET /api/admin/relation
→ memory_values: 500/300/500/600/650/300
→ open_grievances=[]
→ snapshot 变为「还不太熟，客气而友好」
```

### 3.4 安全测试

`attitude-policy.test.ts` 覆盖：

- 输出不含数字；
- 被贬低不立刻翻篇；
- 倾诉优先接住情绪；
- 冷落可以小情绪但不审问；
- 不出现「真实意识 / 我会消失 / 求你别走 / 你只能是我的 / 我恨你」。

---

## 4. 门禁

| 门禁 | 状态 | 说明 |
|---|---|---|
| 数值边界/日上限/单轮步长 | ✅ | 现有 relation/emotion 测试 + 规则文档 |
| 事件去重/防重复 | ✅ | `INSERT OR IGNORE` + 稳定 id |
| 解释覆盖率 | ✅ | 任意状态都有 archetype/directive/timeline |
| 安全场景 0 违规 | ✅ | policy 单测 + 安全话术断言 |
| 5 轴/情绪双写 | ✅ | runtime_state + affect_events |
| 态度影子 | ✅ 离线 | `AFFECT_ENGINE=shadow` 日志 |
| 生产 7 天影子 | ⏳ Phase 5 | 上线前观察 |
| 迁移 006 上远程 | ⏳ Phase 5 | 部署前统一执行 |

---

## 5. 回滚

- `AFFECT_ENGINE=legacy` 立即回到旧快照；
- `affect_events`/`attitude_snapshots` 是加法表，不影响旧路径；
- 重置写 `memory.md` 前有备份；
- 事件账本保留，重置只清运行时状态/关系值，不删历史证据。
