# 交接文档 · 2026-10-31 03:00

> 给下一个窗口的接手人。这份文档假设你没有本会话的记忆，读完就能接着干。
> **UI 重设计部分不在本文范围内**（网页和 App 的视觉改版由用户自己处理）。

---

## 一、30 秒速览

| 项 | 值 |
|---|---|
| 引擎仓库 | `D:\WorkSpace\ds-memory`（Cloudflare Worker，Hono + TypeScript ESM） |
| App 仓库 | `D:\WorkSpace\ds-mobile`（Kotlin + Compose，公开仓库 `dikt-dev/ds-mobile`，Apache-2.0） |
| 线上地址 | `https://fae.us.ci`（Worker 名 `ds-memory`） |
| 引擎 HEAD | `eaf3c5b`，已部署，Version ID `92297db2-34b7-4342-87b6-20c56770e0c2` |
| App HEAD | `b77b8bd`，已构建 release 并装到手机 |
| 测试 | 77 个文件 / **881 个用例全绿**，`npx tsc --noEmit` 干净 |
| 冻结状态 | **已解除**，10-31 凌晨全量部署过一次（含积压的 190+ 提交） |
| 手机 | Redmi K60，`adb devices` 里是 `9ef7a283` |
| 数据规模 | D1 `messages` 表 276 行，内容合计 65 KB，最新一条 `2026-10-30T23:54:52+08:00` |

---

## 二、系统是什么

一个「有长期记忆的私人 AI 伙伴」，两半：

- **引擎（ds-memory）**：跑在 Cloudflare 上的对话 + 记忆 + 情绪 + 主动消息。D1 存消息/记忆索引，R2 存记忆文件与媒体，KV 存缓存与设备令牌，Workers AI 做向量，DeepSeek 出对话。
- **App（ds-mobile）**：Android 客户端，唯一移动入口（QQ/Termux 那条线已下线）。Room 存消息历史，磁盘缓存图片/动图/视频/TTS。

记忆分层（改代码前必须知道）：
- 短期 = D1 `messages`
- 中期 = KV `memo:24h:v2`
- 长期 = R2 `memory.md` + D1 `memory_chunks`
- 情绪 = 8 维向量；脾气 = temper（会拒绝）
- 主动性 = cron `0 20 * * *`（日结）、`* 1-14 * * *`（白天随机）、`* 23,0,14,15,16 * * *`（早晚/深夜槽）

---

## 三、最近 24 小时做了什么（以及我搞坏过什么）

### 3.1 App 侧

1. **拍照**：弃掉自绘 Camera1 预览（模糊 + 4:3 拉伸变形），改用系统相机 `ActivityResultContracts.TakePicture` + FileProvider。拍完**先挂成草稿**，用户确认才发。压缩到长边 2048 / q88 再上传。
2. **缓存扩容**：磁盘 1 GB → 4 GB、文件数 5000 → 20000，内存图片 24 → 48 张；视频落地成文件，二刷不再下载。
3. **后台保活瘦身**：删掉了每 3 秒一次的 `/api/health` 探测（那接口要查一次 D1 + 读一次 KV，一天 28800 次请求，只为给通知栏刷一行时间戳）。现在连接状态由 `eventLoop` 的成败驱动：成功写「已连接」，失败写「重连中…」。**额外请求归零**。
4. **Release 包**：`:app:assembleRelease`，107 MB（未开 R8），签名沿用 debug keystore，所以是原地升级、不丢数据。

### 3.2 引擎侧

1. **配对码改成可在线设置**：`/api/app/pair` 现在按 **KV `pair:code` > 环境变量 `APP_PAIR_CODE` > 回退 `ASTROBOT_API_KEY`** 取值。新增 `GET/POST /api/admin/pair-code`（requireAuth），网页头部有「配对」入口，可随机生成（去掉了 0/O/1/I）、保存、清除回退。**好处：改码不用重新部署，也不用把长期 API Key 当配对码用。**
2. **KV 缓存**：`/api/day` 缓存 10 分钟（天气要打外网），`/api/balance` 缓存 5 分钟（要打 DeepSeek），两者都给浏览器 `private, max-age=60`。
3. **HTML 改 no-store**：见第六节第 5 条，这条是今天最大的坑。

### 3.3 我改坏过、又撤回来的（别重复）

- 提交 `57254f0`「首屏历史从三次串行往返压成一次」：把「探活 → 今日 → 拉历史」合并成一次请求，为此新写了 `applyHistoryPage`。**上线后历史只零星出几条**，因为新渲染路径没有在本地验证过。
- 已由 `43d8de4` 整体撤回，页面逻辑回到 `c682348` 的状态。
- **要做这个优化，前置条件是在本地或可验证环境先证明渲染正常再上线**，不要拿线上当试验田。优化目标还在：单次从中国到 Cloudflare 的往返约 0.6~0.9 秒，D1 主库在 LAX，一次页面加载串三次就是两三秒。

---

## 四、待办与排期

### 4.1 等你拍板的两个决定

1. **开不开 R8**（`isMinifyEnabled = false` 现在是关的）：开了能把 107 MB 压到 35~45 MB，代价是反射风险（Room DAO 基本不吃反射、`JSONObject` 手动解析安全，但 `DebugSshService` 这类动态路径要单独验）、崩溃栈要留 `mapping.txt`。个人侧装应用的结论是**先不开**，除非要分发给别人。
2. **首屏性能重构要不要重做**：做法没变（合并请求 + 并行），但必须先能验证渲染。

### 4.2 记忆系统排期（详见 `ds-memory/docs/TASKS.md` 第二十节）

| 日期 | 事项 |
|---|---|
| 11-02 | 回忆分享决策（分享原文还是摘要）、记忆恢复 API |
| 11-03 | 记忆恢复 API（误删/回滚） |
| 11-04 | 分级召回兜底（T-11a 残留） |
| 11-06~07 | 情绪向量复检（8 维是否还准，需要连续 5 天样本） |
| 11-08 | T-11b/c + K-1/K-2 |
| 11-09 | K-4 验收 |
| 11-10~11 | T-13（对话内纠错） |
| 11-12~13 | T-14（长会话压缩） |
| 11-15 起 | Phase 6（关系系统收口） |

另外一直挂着的：**A-7 代码整理**——`ChatActivity.kt` 已 3153 行，建议先出审查报告（行数分布、死代码、注释与实现不一致处）再拆。

---

## 五、环境与命令

### 5.1 App 构建 / 装机 / 截图

```powershell
cd D:\WorkSpace\ds-mobile

# 调试包（快，验 UI 用）
& "D:\Program Files\Gradle\gradle-9.8.2\bin\gradle.bat" :app:assembleDebug --console=plain *> build.log

# 发布包（慢一倍多，交付用）
& "D:\Program Files\Gradle\gradle-9.8.2\bin\gradle.bat" :app:assembleRelease --console=plain --no-daemon *> build-release.log

Select-String -Path build.log -Pattern "^e: |BUILD " | Select-Object -First 10   # 只看错误和结果

adb install -r app\build\outputs\apk\release\app-release.apk
adb shell am force-stop com.dsmobile.app
adb shell am start -n com.dsmobile.app/.ChatActivity
adb shell screencap -p /sdcard/s.png; adb pull /sdcard/s.png D:\WorkSpace\_shot.png
# 然后用 read_image 看 _shot.png —— 别靠想象判断 UI
```

### 5.2 引擎

```powershell
cd D:\WorkSpace\ds-memory
npx vitest run          # 881 用例
npx tsc --noEmit

# 部署（必须带 account id）
$env:CLOUDFLARE_ACCOUNT_ID="1d0cedf164665fcc2ff558ec4a0564a2"
npx wrangler deploy -c wrangler.local.toml

# 直接查线上 D1（只在 wrangler.local.toml 里配了 --remote 时才有效）
npx wrangler d1 execute ds-memory-db --remote -c wrangler.local.toml --command "SELECT COUNT(*) FROM messages" --json
```

### 5.3 线上验证（我常用的三招）

```js
// 在 run_code 里用 node 的 fetch，比 curl 靠谱
const r = await fetch('https://fae.us.ci/');            // 200 + 页面长度
const t = await r.text();
console.log(t.includes('某段新代码'));                    // 确认部署是否真的生效
await fetch('https://fae.us.ci/api/app/pair', {method:'POST', ...})  // 401/503 判断配对是否配置
```

---

## 六、坑（全部踩过，按踩到时流的血排序）

1. **pwsh 的 `workdir` 必须显式给**。不给就落到 `D:\WorkSpace` 根目录，`adb install` 会打印 `Performing Streamed Install` 然后**静默失败**，你以为装上了其实还是旧包。判断依据：没有 `Success` 就是没装上。

2. **PowerShell 把 git 的 stderr 当错误**。`git push` 输出 `Everything up-to-date` 走的是 stderr，退出码 1，看着像失败其实成功。**别信退出码，用 `git fetch` + `git status -sb` 判断是否同步**。同理 `ahead N` 可能是没 fetch 的旧缓存。

3. **Gradle 守护进程会被打断的构建带坏**。症状是 `The daemon has terminated unexpectedly on startup` 或者一堆莫名的 `unresolved reference`。处理：`gradle --stop`，然后加 `--no-daemon`、必要时 `--rerun-tasks` 重来。

4. **Kotlin 局部函数必须先声明后使用**。写在 `@Composable` 里的 `fun foo()` 只能被它后面的代码调用；写在前面就是 `Unresolved reference`。工具函数（图片压缩之类）提到调用点之前。

5. **Cloudflare 静态资源没有 ETag/Last-Modified，浏览器会启发式缓存**。今天最惨的一次：我改了三轮前端，用户一直看到旧页面，却以为是我修不好。现在 Worker 对 HTML 统一 `cache-control: no-store`（`index.ts` 里 `app.get('*')` 那段）。**以后凡是「我改了但看不到」，第一件事是查响应头，别怀疑代码。**

6. **`wrangler tail` 在这条网络上连不上**（`ETIMEDOUT` 到 `173.231.12.107:443`），所以**看不到线上日志**。替代手段：`wrangler d1 execute` 查数据、node fetch 打接口看状态码、让用户贴 Console 报错。

7. **`curl https://fae.us.ci/` 有时只返回 1.8 KB**（同一时刻 node fetch 是 72 KB）。别用 curl 的长度判断页面好坏，用 node 的 fetch。

8. **ds-memory 的 TS 文件是 CRLF**。跨多行的字符串 `replace` 会全部 MISS（我因此白改过两次），改成单行锚点、正则，或在脚本里显式用 `\r\n` 拼接。

9. **`public/index.html` 的行号在 grep 和 node 的 split 结果里不一致**（文件混了换行符）。**不要按行号做手术**，会误删无关代码；要改就按唯一字符串定位。真要做大改，先 `git checkout` 到干净版本再动。

10. **D1 的库名不是 Worker 名**：是 `ds-memory-db`（binding 才是 `DB`）。写错会报「Couldn't find a D1 DB」。

11. **部署必须带 `CLOUDFLARE_ACCOUNT_ID`**，否则 wrangler 会去问交互式账号。

12. **App 的 release 签名 = debug keystore**（`build.gradle.kts` 里 `signingConfig = signingConfigs.getByName("debug")`）。好处是原地升级不丢数据；坏处是这个包不能上架应用商店，也没法给别人签同一个身份。

---

## 七、红线与产品哲学

改代码前必须守住：

- **事件阶段 A 只写不读**；**引用必须逐字**；**第一次/去年这类记忆不随时间衰减**；**永不物理删除记忆**；**雷区与禁忌永不过期**。
- 验收指标（v2）：要点命中率 ≥85%、时间引用准确率 ≥90%、改口一致性 100%、编造率 0%、无效注入率 ≤15%、A/B 胜率 ≥70%。
- 聊天流量**不要**走 OpenCode Go（ToS 风险），代码里零依赖。

产品性格（影响文案、提示词、UI 措辞）：
- 她**不是助手**。有自己的情绪、脾气，会拒绝、会闹、会因为心情不好不想说话。
- 界面上不要出现「智能助理」「为您服务」「满意度」这类词，要像一个人在跟你说话。
- 同一套哲学也适用于代码：**只告诉她是谁、能做什么，不规定怎么做**。
- 用户明确说过：「我们尽量不约束 AI，只告诉她是谁，可以干什么」。改 prompt 时别加行为清单。

---

## 八、数据现状（不要随手清）

- D1 `messages`：276 行 / 65 KB，最新 `2026-10-30T23:54:52+08:00`。
- 已知脏数据，**用户已拒绝清理**：15 条 `affect_events` 分类错误、`grievance` 值 64。别自作主张洗数据。
- 记忆文件在 R2：`memory.md`、`archive.md`；改完要 `POST /api/admin/memory/refresh` 才会丢缓存重建。
- 配对：线上 `APP_PAIR_CODE` 没设，实际回退到 `ASTROBOT_API_KEY`（在 `.dev.vars` 第 16 行）。**建议让用户在网页上设一个独立配对码**，别长期拿 API Key 当配对码。

---

## 九、交接时的未提交物

- `D:\WorkSpace\ds-memory\public\_diag.html`（未跟踪）——来源不明，我这边没创建过，用之前先看一眼内容再决定留删。
- 工作区根目录有几个临时产物可忽略：`_shot*.png`、`_rel.png`、`_webcheck.js`、`push*.log`、`deploy*.log`、`tail.log`、`d1stat.json`。

---

## 十、给接手人的三条建议

1. **改前端后，先用 node fetch 确认线上文件里真的有你的改动**，再让用户刷新。今天的连环翻车全部源于「以为部署了」。
2. **改 App 后先 `screencap` 看一眼**，别只看编译通过。头像尺寸、气泡层次这类问题，编译永远不会报错。
3. **动记忆/情绪相关的逻辑前，先跑一遍 `npx vitest run` 留基线**，881 个用例是你唯一的安全网。
