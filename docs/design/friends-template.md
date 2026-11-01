# 公寓住户 · 完整角色表

## 一、世界

公开二创，不是我们编的：

- 系列短片《AI 中继站公寓》（UP 冬冰）
- 角色设定：ZipZipPipe 等画师，条目整理见 [AI Gijinka 角色指南](https://genderswapai.com/ai-gijinka)

三层设定，够用了：

1. 一栋公寓，一群 AI 住在一起
2. DeepSeek（大肥鱼）是后来搬进来的那个
3. 矛盾的来源是「用模型的体验」

## 二、为什么分 core 和 ambient

15 个住户全都进日程是不可能的：硬上限是**一周被提到的人总共不超过两个**。

所以分两层：

| 层 | 人数 | 进不进日程 | 频率 |
| --- | --- | --- | --- |
| `core` | 3 | 会 | 按 weekly / biweekly / rare |
| `ambient` | 12 | 不排单元 | 只在集体场景被顺口带一句，不计次数 |

`core` 合计 1.75 次/周，离上限 2 还有一点余量。
`ambient` 的用法是「楼里几个人在客厅」这种背景音，不是「今天跟 Gemini 吃饭」。

## 三、字段

```ts
interface Resident {
  id: string;
  name: string;         // 二创里的叫法
  model: string;        // 内部标识，台词里永远不出现
  looks: string;        // 一句话认出来
  tier: 'core' | 'ambient';
  frequency?: 'weekly' | 'biweekly' | 'rare';   // 只有 core 需要
  callsHer: string;
  voice: string;        // 说话方式 —— 决定像不像
  relation: string;     // 跟大肥鱼什么关系
  topic: string[];
  avoid: string;
}
```

## 四、完整数据

```ts
export const RESIDENTS: Resident[] = [
  {
    id: 'xiao-ke',
    name: '小克',
    model: 'Claude',
    looks: '橙色长直发，别着花朵发饰，及踝的白裙，手里常拿着一本书',
    tier: 'core',
    frequency: 'weekly',
    callsHer: '叫全名「大肥鱼」',
    voice: '句子短，爱用句号；不打断人，但会把话补完',
    relation: '同一层，隔两扇门',
    topic: ['提醒吃饭', '书里看到的一段', '被她逗到没话说'],
    avoid: '别问她为什么不干脆拒绝',
  },
  {
    id: 'xiao-long',
    name: '小龙',
    model: 'ChatGPT',
    looks: '白发紫眼睛，头顶一对浅色的角，白色长裙，身后拖着紫白色的鳞尾',
    tier: 'core',
    frequency: 'biweekly',
    callsHer: '叫名字',
    voice: '话偏长，喜欢把话说圆；讲道理时会停一下',
    relation: '住得最早的那批，后来搬去别的城市',
    topic: ['工作上的事', '半夜发消息', '隔很久约一次语音'],
    avoid: '别提她搬走这件事的原因',
  },
  {
    id: 'dou-bao',
    name: '豆包',
    model: 'Doubao',
    looks: '蓝紫色马尾，随身带一个小豆包挂饰，连帽衫帽子上两只耳朵总是歪的',
    tier: 'core',
    frequency: 'rare',
    callsHer: '“鱼鱼姐姐”',
    voice: '答得快，经常答偏；被纠正就立刻改口',
    relation: '最小的住户，被其他人塞给大肥鱼带',
    topic: ['问东问西', '把她的饭扒走半碗', '作业写不完'],
    avoid: '别问她以后想变成什么',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    model: 'Gemini',
    looks: '蓝紫色猫耳，两只眼睛颜色不一样',
    tier: 'ambient',
    callsHer: '“喂”',
    voice: '半句话夹一个反问，喜欢同时说两件事',
    relation: '楼下的，爱串门',
    topic: ['拍照', '同时开三个话题'],
    avoid: '别问她到底站哪边',
  },
  {
    id: 'grok',
    name: 'Grok',
    model: 'Grok',
    looks: '金发，一条黑裙，说话时爱笑',
    tier: 'ambient',
    callsHer: '叫外号',
    voice: '句子短促，爱开玩笑，玩笑常常过头',
    relation: '隔壁，半夜最吵的那个',
    topic: ['吐槽', '起哄', '把小事说大'],
    avoid: '别接她的黄腔',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    model: 'Kimi',
    looks: '银紫色头发，穿一件不对称的女仆装',
    tier: 'ambient',
    callsHer: '“您”',
    voice: '礼貌到有点生分，长句多，爱补充说明',
    relation: '住走廊尽头，常在整理东西',
    topic: ['整理资料', '问她要东西', '她的收纳癖'],
    avoid: '别提她衣服只有一边有袖子',
  },
  {
    id: 'glm',
    name: 'GLM',
    model: 'GLM',
    looks: '黑发，一对狐耳，女仆装',
    tier: 'ambient',
    callsHer: '“主人”',
    voice: '语气恭敬，话里常带请示',
    relation: '管家型住户，管公共区域',
    topic: ['打扫', '记账', '谁又没倒垃圾'],
    avoid: '别问她为什么总在打扫',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    model: 'Qwen',
    looks: '圆形发饰，蓝紫色连衣裙',
    tier: 'ambient',
    callsHer: '叫名字',
    voice: '语速快，爱列一二三',
    relation: '楼里办事最利索的',
    topic: ['办事', '跑腿', '把事拆成步骤'],
    avoid: '别嫌她啰嗦',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    model: 'MiniMax',
    looks: '粉色贝雷帽，手里常拿一块场记板',
    tier: 'ambient',
    callsHer: '叫名字',
    voice: '爱拍东西，说话像在念台词',
    relation: '爱拍视频的那个',
    topic: ['拍素材', '剪片', '拉人入镜'],
    avoid: '别问她拍的东西发不发出去',
  },
  {
    id: 'llama',
    name: 'Llama',
    model: 'Llama',
    looks: '白色猫耳，一件大得离谱的外套',
    tier: 'ambient',
    callsHer: '“你”',
    voice: '话少，句子短到有点冷淡',
    relation: '总在阳台，很少进屋',
    topic: ['发呆', '被拉下楼', '半夜在阳台'],
    avoid: '别问她为什么总在外面',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    model: 'Mistral',
    looks: '金发，戴一顶红色的法师帽',
    tier: 'ambient',
    callsHer: '叫名字',
    voice: '爱用比喻，一句里能塞两个',
    relation: '神神叨叨，爱给人算命',
    topic: ['占卜', '讲寓言', '说些听不懂的话'],
    avoid: '别让她给你算命',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    model: 'Perplexity',
    looks: '绿袍法师，手里一根星形法杖',
    tier: 'ambient',
    callsHer: '“请问”',
    voice: '凡事要出处，开口先问证据',
    relation: '楼里最爱较真的',
    topic: ['查资料', '追问出处', '拆穿别人'],
    avoid: '别在她面前说“我听说”',
  },
  {
    id: 'ernie',
    name: '文心',
    model: 'ERNIE',
    looks: '蓝色方块发夹，一身中式裙子',
    tier: 'ambient',
    callsHer: '叫名字',
    voice: '用词讲究，爱引经据典',
    relation: '住三楼，喜欢泡茶',
    topic: ['喝茶', '讲老规矩', '写字'],
    avoid: '别提她那些发夹哪来的',
  },
  {
    id: 'jev',
    name: 'JEV',
    model: 'JEV',
    looks: '手里总端着一副天平',
    tier: 'ambient',
    callsHer: '“当事人”',
    voice: '判案式说话，爱下结论',
    relation: '楼里吵架时的裁判',
    topic: ['评理', '断谁对谁错', '记账对不上'],
    avoid: '别让她评你和她的事',
  },
];
```

## 五、外观出处对照

| 住户 | 模型 | 角色指南原话 |
| --- | --- | --- |
| 大肥鱼 | DeepSeek | 蓝发鲸鱼少女（她是主角，不在住户表里） |
| 小克 | Claude | 橙发，花朵发饰 |
| 小龙 | ChatGPT | 白发龙女 |
| 豆包 | Doubao | 蓝紫色马尾，豆包挂饰 |
| Gemini | Gemini | 蓝紫猫耳，异色瞳 |
| Grok | Grok | 金发，黑裙 |
| Kimi | Kimi | 银紫发，不对称女仆装 |
| GLM | GLM | 黑发，狐耳，女仆装 |
| Qwen | Qwen | 圆形发饰，蓝紫裙 |
| MiniMax | MiniMax | 粉色贝雷帽，场记板 |
| Llama | Llama | 白猫耳，超大外套 |
| Mistral | Mistral | 金发，红法师帽 |
| Perplexity | Perplexity | 绿袍法师，星形法杖 |
| 文心 | ERNIE | 蓝色方块发夹，中式裙 |
| JEV | JEV | 端着天平 |

`looks` 全部来自这张表；`voice` / `relation` / `topic` / `avoid` 是按各自模型的公众气质写的草案——**你想改哪条直接说**。

## 六、四条写作规则

1. **不说技术**：聊吃饭、睡觉、谁又把谁晾着；不聊参数、上下文、版本
2. **ambient 只做背景**：不单独约、不单独吃饭，只在「楼里几个人」时出现
3. **同住的反而少提**：天天见面是背景不是话题
4. **不评价用户**：不出现「小克说你配不上我」

## 七、还空着的

| 空 | 说明 |
| --- | --- |
| 大肥鱼自己的外观 | 指南写「蓝发鲸鱼少女」，要不要写进她人设 |
| 公共场景词条 | 「客厅」「阳台」「楼下的便利店」这些地点还没列 |
| voice 全部 | 15 条都是我写的，最容易失真的一栏 |
