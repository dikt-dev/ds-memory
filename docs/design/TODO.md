## 2026-11-02 主动消息改版（已完成）
- [x] 去掉早晚固定问候档，只保留白天随机档
- [x] 档位由亲密度决定：<400 quiet（75% 不发，上限 1）、<700 normal（45% 不发，上限 2）、≥700 active（15% 不发，上限 3）
- [x] 一条聊天记录都没有时不发随机档（C）
- [x] 去掉 wrangler.toml 里写死的 PROACTIVE_LEVEL，交给亲密度
- 现状：亲密度 300 → quiet，今日计划 0 条

## 2026-11-02 重置（已完成）
- [x] 记忆/索引/消息/日记/日程/情绪/画像 全清，R2 旧归档（chat_logs、images、memory/archive.md）删除
- [x] 新人设种子写入（鲸鱼娘 / 杭州独居 / 邻居 / 爸 梁圣 / 损友向）
- [x] 人设开关进 env（PERSONA_SELF_CALL / PERSONA_ROLE / PERSONA_ADDRESS_NOTE / PERSONA_TONE）
- [x] 口癖硬限 ticWarning；场景加天台、楼下小馆
- [x] 冒烟：身份正确、承认记忆空白、不叫主人

# 待办

最后更新：2026-11-02（含评审改进清单）

## 一、下一步要做的功能

### 1. 搬家按钮（API 有了，缺入口）

`POST /api/admin/life/move?city=` 已经能用：校验 12 城 → 改写 `life:home-city` → 删当天 env/day → 重置 + 重新生成 → 记忆里记一行「从上海搬到了杭州」。

差的是**界面**：

- [ ] App「我的」页加「换个住处」，点开列 12 个城市
- [ ] 网页端后台同步加一个入口（admin 页面）
- [ ] 搬完给一句反馈（她现在住哪、老邻居还会被提起）
- [ ] 确认搬完的老住户关系仍然成立（大白龙搬走、其他邻居还在）

### 2. 住户后续

- [x] 公共场景落地：社交写进客厅/厨房/阳台/楼下便利店；家里的活动写房间（`place.ts`）
- [x] 集体活动：每周一次、3 个人（核心 + 背景住户），标题「和小克、豆包吃饭」
- [x] `chat.ts` **不能删**：`index.ts:402` 和 `life/flush.ts`（消息闸门到点补发）都在用
- [x] 提示词生活块合并：`src/chat-blocks.ts`（名录 + 此刻状态 + 当天卡片）由两个入口共用，不会再「只改了一边」
- [ ] 剩余差异：历史组织/录音/计费仍是两套（`chat.ts` 走会话 + 流式落库，`openai.ts` 走 messages + gate）。彻底合并要把 openai 的处理体抽成通用函数，约一天

## 二、待验证

- [x] 「问问她」后一直不说话，15 分钟自动收回（已验证）
- [ ] 04:00 归档 + 04:05 日记两条 cron 连续跑几天稳定
- [ ] 手机上 `declined` 显示「她说不给」+ 冷却倒计时（APK 已装，未在真机确认）
- [ ] 日记冷了再问（30 分钟冷却）在真机上的提示
- [ ] 营业时间/空档改动后，连续几天的日程是否自然（新建的 7 段/天先观察）

## 三、已知风险

- **KV 最终一致**：刚改完位置/记忆立刻读会拿到旧值（已经踩过三次：记忆行复活、日程还是旧城市、日记还是北京）。补/删记忆行已改读 R2 原文；其他 read-modify-write 路径仍可能中招
- **日记没有补跑机制**：归档有 7 天 catch-up，日记失败就那天没有
- **天气必须两边分别取**：她 `life:env:{date}`、你 `life:user-env:{date}`
- **思考模式吃输出额度**：日记的 JSON 尾行可能被挤掉，靠「单独补摘要」兜底（已有 `summary_source` 可查）
- **历史数据里的匿名社交**：10-31 及更早的日程还有「和朋友…」，那些天没有日记引用，暂不处理

## 四、已完成（备查）

- **公寓住户五期**（P1 数据 / P2 排期+people 落库 / P3 日记注入 / P4 聊天注入 / P5 匿名条目清除）
- **日程细节**：营业时间（商场 10–22、书店 9–21、菜市场 16–23…）、空档填充 30%→40%、单窗口最多 4 件
- **日记质量监控**：`finish_reason` / `summary_source` / `text_len` 落库，异常打告警
- 日记：独立 cron、思考模式、摘要进授权判断、拒绝落 declined、30 分钟冷却、截断解析、天气转中文、摘要兜底
- 位置：她跟 home-city（旅游取目的地，atHome=false），你跟 App 定位
- 记忆：形象补全（鳍耳/发带/蓝眼）、日记规则、住上海、公寓与爸 梁圣
- 授权：点哪篇问哪篇、多篇一起解、15 分钟 TTL、判断挪到打开日记时

## 2026-11-02 发现

- **/v1/chat/completions 走的是 src/openai.ts，不是 src/chat.ts**。生活行（她此刻在干什么）一直只接在 chat.ts 上，所以聊天里她其实「不知道自己今天在哪」——已补到 openai.ts（稳定段放名录、易变段放生活行+当天卡片）。chat.ts 现在疑似死代码，待确认后删。
- 住户卡片的「别碰」会被当真：问大白龙搬走的事，她会装不认识（实测），这是设定生效，不是 bug。

## 五、代码评审改进清单（2026-11-02）

来源：外部评估 + 我逐条复核。复核发现它的「召回撞墙」结论不成立（`memory_chunks` 只有 103 条，JS 打分是微秒级；503ms 应来自 Workers AI embedding 或 D1 往返）。

### 基线（实测）

| 指标 | 值 |
|---|---|
| memory_chunks / entries | 103 / 97 |
| messages / ai_diary | 65 / 1 |
| admin-routes.ts | 1399 行 / 88 路由 |
| 测试 | 1235 通过 |
| MEMORY_ENGINE 声明 | 8 处，全 shadow |

### P0 会静默出错（今天做）

- [ ] **配对接口限流**：`POST /api/app/pair` 是唯一公网无凭据写入端点，无限流。复用 `index.ts` 的 `login:fail:${ip}` 模式，建 `pair:fail:${ip}`，10 次/小时/IP（约 30 分钟）
- [ ] **设备 Token 吊销**：`app:device:<token>` 被 middleware / openai / queue-auth / routes-app 四处各读一份，没有删除接口。加 `POST /api/app/unpair`（删自己的 key）+ 后台设备列表/吊销 + 四处读取收敛成 `readDeviceToken()`（服务端 1 小时）
- [ ] **DeepSeek 超时**：`deepseek.ts` 的 fetch 无 AbortController，上游卡住用户一直转圈。加 60s 超时 + 一次重试；**流式已开始回调后不要 abort**，否则半截回复会被当成功落库（约 40 分钟）
- [ ] **/api/health 收敛**：公开返回 `deepseek_key` / `password` / `storage_mode` 等配置状态，搬到 requireAuth 的 `/api/admin/readiness`（约 20 分钟）
- [ ] **16 处 `void promise(...)` 补 `.catch()`**：`void` 只表示不管返回值，不表示不会抛；未处理拒绝在 Workers 里可能打断请求（约 30 分钟）

### P1 结构性（本周）

- [ ] **移动端测试基建**：`ds-mobile` 无 test 源集、gradle 无 testImplementation。先把 ApiClient 的 JSON 解析、ChatText 纯函数抽出来，加 junit + coroutines-test（约半天）
- [ ] **拆 admin-routes.ts**：88 条路由切成 `admin/memory-routes.ts`、`admin/life-routes.ts`、`admin/ops-routes.ts`。改完删 `src/routes.snapshot.json` 让它重生成，核对一条不少（2–3 小时）

### P2 整洁（顺手做）

- [ ] **仓库根目录**：39 个文件里 31 个是 png/log。约定 `*.log`、调试截图不进根目录，产物进 `.tmp/`（约 20 分钟）
- [ ] **文档数字**：`docs/HANDOFF.md` 还写着「881 用例 / ChatActivity.kt 3153 行」，实际 1235 / 1391（约 15 分钟）
- [ ] **cron 分发**：5 个表达式合并后在 `scheduled()` 字符串比对，抽成常量映射表 + 一条「每个 cron 都有处理分支」的断言

### 明确不做（有理由）

- **上 Vectorize / 重写召回**：103 条向量，瓶颈不在打分。先给 recall 加分段计时（D1 / embedding / 打分），再决定
- **关闭 shadow 引擎**：它是切换前的对照。先做采样比对（5% 流量比召回差异），定切换日期，否则等于盲切
- **全流程合并 chat.ts / openai.ts**：生活块已合并成 `chat-blocks.ts`；剩下的历史组织/计费差异改动面大、收益低

### 待拍板

- 吊销入口放哪：App 设置页 / 网页后台 / 两边都要
- 配对限流阈值：建议 10 次/小时/IP
- 移动端是否引入测试依赖：只影响 test 配置，不影响 APK 体积
