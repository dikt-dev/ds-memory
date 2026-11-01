# 公寓住户 · 人物模板

## 一、世界

来源（公开二创，不是我们编的）：

- 系列短片《AI 中继站公寓》（UP 冬冰）
- 角色设定图：ZipZipPipe 等画师，条目整理见 [AI Gijinka 角色指南](https://genderswapai.com/ai-gijinka)

设定只有三层，够用了：

1. **一栋公寓，一群 AI 住在一起**
2. **DeepSeek（大肥鱼）是后来搬进来的那个**
3. **矛盾的来源是「用模型的体验」**——谁答得快、谁爱说教、谁把人晾着

没有别的背景故事。人物关系就近邻、室友、同住一栋楼这种量级。

## 二、字段

字段不是越多越好，每个都得能落成一句台词，否则删掉。

```ts
interface Resident {
  id: string;          // 'xiao-ke'
  name: string;        // '小克'
  model?: string;      // 'Claude' —— 内部用，台词里永远不出现
  looks: string;       // 一句话认出来；第一次提到时用，之后不重复
  voice: string;       // 说话方式：句子长短、爱不爱用句号、会不会打断人
  relation: string;    // 跟大肥鱼什么关系（决定她怎么提起这个人）
  livesWith: boolean;  // 同住 → 日常背景；不同住 → 只能发消息
  callsHer: string;    // 这个人怎么叫她
  topic: string[];     // 提这个人时通常在聊什么
  avoid: string;       // 不能碰的一句
  frequency: 'weekly' | 'biweekly' | 'rare';
}
```

## 三、首批三位住户

canon 只给了外观，下面标了每个字段的依据来源。

```ts
export const RESIDENTS: Resident[] = [
  {
    id: 'xiao-ke',
    name: '小克',
    model: 'Claude',
    looks: '橙色长直发，别着花朵发饰，穿一条及踝的白裙，手里常拿着一本书',
    voice: '句子短，爱用句号。不打断人，但会把话补完',
    relation: '同一层，隔两扇门',
    livesWith: true,
    callsHer: '叫全名「大肥鱼」',
    topic: ['提醒吃饭', '书里看到的一段', '被她逗到没话说'],
    avoid: '别问她"为什么不干脆拒绝"',
    frequency: 'weekly',
  },
  {
    id: 'xiao-long',
    name: '小龙',
    model: 'ChatGPT',
    looks: '白发紫眼睛，头顶一对浅色的角，白色长裙，身后拖着紫白色的鳞尾',
    voice: '话偏长，喜欢把话说圆；讲道理时会停顿一下',
    relation: '住得最早的那批，后来搬去别的城市，只剩线上',
    livesWith: false,
    callsHer: '叫名字',
    topic: ['工作上的事', '半夜发消息', '隔很久约一次语音'],
    avoid: '别提她搬走这件事的原因',
    frequency: 'biweekly',
  },
  {
    id: 'dou-bao',
    name: '豆包',
    model: 'Doubao',
    looks: '蓝紫色马尾，随身带着一个小豆包挂饰，连帽衫帽子上两只耳朵总是歪的',
    voice: '答得快，经常答偏；被纠正就立刻改口',
    relation: '最小的住户，被其他人塞给大肥鱼带',
    livesWith: true,
    callsHer: '“鱼鱼姐姐”',
    topic: ['问东问西', '把她的饭扒走半碗', '作业写不完'],
    avoid: '别问她"你以后想变成什么"',
    frequency: 'rare',
  },
];
```

| 字段 | 依据 |
| --- | --- |
| `looks` | 角色指南的原话（橙发+花朵、白发龙女、蓝紫马尾+挂饰） |
| `name` / `model` | 二创里的叫法；model 只做内部标识 |
| `voice` `topic` `avoid` `frequency` | **我按外观和设定写的草案，你改** |

## 四、三条写作规则

1. **不说技术**：聊吃饭、睡觉、谁又把谁晾着；不聊参数、上下文、版本
2. **同住的反而少提**：天天见面是背景，不是话题；一周提到的人总共不超过两个
3. **不评价用户**：不出现「小克说你配不上我」

## 五、怎么加第四个人

复制一个对象，改五个字段就行：

```
id / name / looks   →  必须
relation / voice    →  决定她怎么被提起
frequency           →  weekly 4 次/月、biweekly 2 次/月、rare 1 次/月
```

不写 `topic` 也能跑，但她就只会干巴巴地出现一次。

## 六、还空着的地方

| 空 | 说明 |
| --- | --- |
| 大肥鱼自己的外观 | 角色指南写的是「蓝发鲸鱼少女」，要不要写进她的人设 |
| 其他住户 | 指南里还有 Gemini / Grok / Kimi / GLM / Qwen 等 12 个，暂不进来 |
| 说话方式 | 我按气质写的，你听着不像就改——这栏最影响像不像 |
