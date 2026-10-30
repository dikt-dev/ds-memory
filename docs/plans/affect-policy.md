# Affect Policy：5 轴、情绪与态度

> Phase 3 的规则文档。所有数值都只在管理端/调试接口出现，**不进提示词**。

## 1. 关系 5 轴

| 轴 | 含义 | 默认 | 单日上限 |
|---|---|---:|---:|
| `affection` 喜欢 | 互动质量、被善待 | 500 | ±5 |
| `trust` 信任 | 坦白、依赖、守约 | 600 | ±4 |
| `respect` 尊重 | 被当人看、不被工具化 | 650 | ±4 |
| `attraction` 心动 | 亲密 + 表白/黏人/深夜深聊 | 300 | ±4 |
| `intimacy` 熟悉 | 互动量、共同经历 | 300 | ±4 |

- 范围 0–1000；轮级单轴 ±1.5，日结算截断到上表上限；
- `memory.md` 存整数，运行时增量存 D1 `runtime_state`；
- 轴背离优先于“总分”：例如 `affection` 高 / `trust` 低 = 喜欢但留一手。

## 2. 情绪 8 维

| 维度 | 半衰期 | 说明 |
|---|---:|---|
| `valence` 愉悦 | 40 min | 整体好坏感受 |
| `arousal` 兴奋 | 25 min | 情绪激活度 |
| `dominance` 底气 | 120 min | 被压一头/有掌控感 |
| `attachment` 依恋 | 360 min | 被冷落的失落 |
| `jealousy` 吃醋 | 180 min | 黏、酸 |
| `grievance` 委屈 | 不衰减 | 只能被道歉/哄修复 |
| `shyness` 害羞 | 15 min | 散得快 |
| `fatigue` 疲惫 | 240 min | 需要休息 |

- 每维 -100–100；单轮单维 ±30；
- `grievance` 不随时间消失；道歉只化解“道歉之前”的负向事件；
- `mood` 不单独维护，由情绪向量派生。

## 3. 事件账本

`affect_events`：

- `kind=emotion`：praise / insult / apology / ignored 等；
- `kind=relationship`：一轮的 5 轴 delta；
- 字段：evidence、intensity、confidence、source_message_id、created_at；
- 只追加、`INSERT OR IGNORE` 防重复；解释/时间线从这里读。

## 4. 态度策略

`buildAttitudePolicy`：

输入：5 轴 + 情绪向量 + 事件 + `wasIgnored`  
输出：

```json
{
  "policy_version": "attitude-v1",
  "archetype": "sulking",
  "tone": "克制",
  "attitude": "亲密，但正在闹别扭",
  "directives": ["..."],
  "reasons": ["委屈", "「你懂什么」还没过去"],
  "safety": {
    "no_consciousness_claim": true,
    "no_guilt_pressure": true,
    "no_abandonment_threat": true
  }
}
```

规则：

1. 关系原型给基调；
2. 情绪给当下修饰；
3. 未化解事件给“别急着翻篇”，但不反复翻旧账；
4. 对方倾诉时优先接住情绪；
5. 被冷落可以有小情绪，但不审问、不威胁；
6. 不输出原始数值，不宣称真实意识，不施加愧疚/遗弃压力。

## 5. 开关与回滚

| 变量 | 值 | 行为 |
|---|---|---|
| `AFFECT_ENGINE` | `legacy`（默认） | 旧 `emotion.snapshot` |
| | `shadow` | 只写 `[trace] affect.policy`，不用 |
| | `next` | 用 `policy.text` 替换状态卡 |

回滚：改回 `legacy`；事件账本是加法表，不影响旧状态。

## 6. 门禁

- 5 轴边界/日上限/单轮步长 100%；
- 事件去重、解释可追溯；
- 安全场景 0 违规；
- 生产 7 天影子在 Phase 5 上线前完成。
