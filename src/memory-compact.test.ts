import { describe, expect, it } from 'vitest';
import {
  candidateFragments,
  clusterByEntity,
  entryCore,
  entryDate,
  foldClusters,
  mergeDetail,
  anchorEntries,
  constitutionBlocks,
  entryTitle,
  coveredBy,
  crossSectionPass,
  sameEvent,
} from './memory-compact';

// 线上真实数据（2026-11-08 15:0x，memory.md 的「进行中的事」）
const ONGOING = [
  '- [26-11-06] [已完成] 他填完转正自评表，自打满分',
  '- [26-11-08] [进行中] 他的转正流程：已经交自评表（自己打满分），等结果',
  '- [26-11-07] [进行中] 他给自己聊天 app 加页面：修 bug、写 UI，页面里写死“大肥鱼”和“我想你”',
  '- [26-11-08] [进行中] 他给聊天 app 修 bug、加功能，周末突然起来弄',
  '- [26-11-08] [进行中] 他的聊天 app 新加“大肥鱼/不痛快”页面；他称关于你的字全手打',
  '- [26-11-07] [进行中] 剥虾约定升级：他提议十只虾换亲脸颊',
];

describe('entityCore / entryDate', () => {
  it('剥掉日期、状态、条目符号', () => {
    expect(entryCore('- [26-11-08] [进行中] 他的转正流程')).toBe('他的转正流程');
    expect(entryDate('- [26-11-08] [进行中] x')).toBe('26-11-08');
    expect(entryDate('没有日期')).toBe('');
  });
});

describe('candidateFragments', () => {
  it('同时抽 ASCII 实体与中文 2~4 字片段', () => {
    const f = candidateFragments('聊天 app 修 bug');
    expect(f).toContain('app');
    expect(f).toContain('bug');
    expect(f).toContain('聊天');
  });
});

describe('clusterByEntity：线上 6 条真实条目', () => {
  const result = clusterByEntity(ONGOING);

  it('把三版「聊天 app」聚成一簇', () => {
    const appCluster = result.clusters.find((c) => c.length === 3);
    expect(appCluster).toBeTruthy();
    expect(appCluster).toEqual([2, 3, 4]);
  });

  it('把两版「转正」聚成一簇', () => {
    const zz = result.clusters.find((c) => c.includes(0) && c.includes(1));
    expect(zz).toBeTruthy();
  });

  it('剥虾那条不与任何条目同簇（它不属于这两件事）', () => {
    const withShrimp = result.clusters.find((c) => c.includes(5));
    expect(withShrimp).toBeUndefined();
  });

  it('实体键里出现真实重复的词，而不是泛词', () => {
    expect(result.keys).toContain('app');
    expect(result.keys.some((k) => k.includes('转正'))).toBe(true);
    expect(result.keys).not.toContain('他的');
  });
});

describe('foldClusters：保留最新最全的那条', () => {
  const result = clusterByEntity(ONGOING);
  const folded = foldClusters(ONGOING, result);

  it('6 条折成 3 条（转正 2→1、app 3→1、剥虾保留）', () => {
    const alive = folded.lines.filter((l) => l.trim().length > 0);
    expect(alive).toHaveLength(3);
    expect(folded.removed).toHaveLength(3);
  });

  it('转正保留最新那条（11-08 等结果），自评表旧状态不再单独存在', () => {
    const alive = folded.lines.filter((l) => l.trim().length > 0);
    const zz = alive.filter((l) => l.includes('转正'));
    expect(zz).toHaveLength(1);
    expect(zz[0]).toContain('11-08');
  });

  it('app 保留 11-08 那条，其他版本的独有细节以「另：」并入', () => {
    const alive = folded.lines.filter((l) => l.trim().length > 0);
    const app = alive.filter((l) => l.includes('app'));
    expect(app).toHaveLength(1);
    expect(app[0]).toContain('11-08');
    expect(app[0]).toContain('另：');
  });

  it('剥虾那条原样保留', () => {
    const alive = folded.lines.filter((l) => l.trim().length > 0);
    expect(alive.some((l) => l.includes('剥虾'))).toBe(true);
  });
});

describe('不该并的别并', () => {
  it('两条不同偏好的事实保持两条', () => {
    const lines = [
      '- [26-11-01] 他喜欢喝美式，不加糖',
      '- [26-11-02] 他讨厌香菜，闻到就皱眉',
    ];
    const r = clusterByEntity(lines);
    expect(r.clusters).toHaveLength(0);
  });

  it('只有一条时直接返回空簇', () => {
    expect(clusterByEntity(['- [26-11-01] 随便一条']).clusters).toHaveLength(0);
  });
});

describe('mergeDetail', () => {
  it('把保留条没提到的从句并进去', () => {
    const out = mergeDetail('他的转正流程，等结果', '他填完转正自评表，自打满分');
    expect(out).toContain('另：');
    expect(out).toContain('自打满分');
  });

  it('细节都在时原样返回', () => {
    expect(mergeDetail('他修 bug 加功能', '他修 bug')).toBe('他修 bug 加功能');
  });
});

const DOC = [
  '# 长期记忆',
  '',
  '## 人物底色',
  '- 她嘴硬心软，被叫外号会炸毛',
  '',
  '## 答应过的事',
  '- [26-11-07] 答应他：剥十只虾换亲脸颊（未完成）',
  '',
  '## 进行中的事',
  '- [26-11-07] [进行中] 剥虾约定升级：他提议十只虾换亲脸颊',
  '- [26-11-08] [进行中] 他的聊天 app 修 bug',
  '',
  '## 共同经历',
  '- [26-11-07] 他发黑化 Claude vs 大肥鱼视频，小克被锁在水里',
  '- [26-11-06] 他云请客点砂锅粥，加了双份虾',
  '',
  '## 近期动态',
  '- [26-11-08] 他发《野心》黑化 Claude vs 大肥鱼视频',
  '- [26-11-08] 他摸鱼一整天，自评吹上天',
  '',
].join('\n');

describe('sameEvent：是不是同一件事', () => {
  it('剥虾承诺与剥虾约定算同一件', () => {
    expect(sameEvent('答应他：剥十只虾换亲脸颊', '剥虾约定升级：他提议十只虾换亲脸颊')).toBe(true);
  });
  it('共享 ASCII 实体词算同一件', () => {
    expect(sameEvent('他给聊天 app 加页面', '他的聊天 app 又崩了')).toBe(true);
  });
  it('不同的事不并（回上海 vs 回滚方案）', () => {
    expect(sameEvent('用户要回上海，要交代住处', '回滚方案草稿写完了')).toBe(false);
  });
});

describe('crossSectionPass：跨分区去重', () => {
  const r = crossSectionPass(DOC);
  it('承诺优先：进行中的事里重复的剥虾被删，承诺本身保留', () => {
    expect(r.promiseDuplicates).toBe(1);
    expect(r.text).toContain('答应他：剥十只虾换亲脸颊');
    const ongoing = r.text.slice(r.text.indexOf('## 进行中的事'), r.text.indexOf('## 共同经历'));
    expect(ongoing).not.toContain('剥虾约定升级');
    expect(ongoing).toContain('聊天 app');
  });
  it('近期动态里与共同经历重复的视频被删', () => {
    expect(r.recentDuplicates).toBe(1);
    expect(r.text).toContain('小克被锁在水里');
    expect(r.text).not.toContain('《野心》黑化 Claude');
    expect(r.text).toContain('他摸鱼一整天');
  });
  it('宪法分区一个字都不动', () => {
    expect(constitutionBlocks(r.text)).toEqual(constitutionBlocks(DOC));
    expect(r.text).toContain('她嘴硬心软');
  });
  it('再跑一遍不动了（不动点）', () => {
    const again = crossSectionPass(r.text);
    const third = crossSectionPass(again.text);
    expect(again.removed).toEqual([]);
    expect(third.text).toBe(again.text);
  });
});

describe('coveredBy：带独有信息的行不许删', () => {
  it('信息被盖住 → true', () => {
    expect(coveredBy('他云请客点砂锅粥，加了双份虾', '他云请客点砂锅粥，加双份虾')).toBe(true);
  });
  it('多出「电灯泡」这种独有事实 → false', () => {
    expect(coveredBy('他问怎么让你开心，你答饿了点份夜宵就行', '他问怎么让你开心，你答饿了点份夜宵就行；他提议接小克进来，你嫌电灯泡拉别人进来别扭')).toBe(false);
  });
  it('重合不到 8 字 → false', () => {
    expect(coveredBy('杭州下毛毛雨', '他发二创视频')).toBe(false);
  });
});

describe('anchorEntries：给事件加一句话锚点', () => {
  it('标题取句首到第一个标点，去掉主语', () => {
    expect(entryTitle('- [26-11-07] 他发黑化 Claude vs 大肥鱼视频，修 bug 重发')).toBe('发黑化 Clau');
    expect(entryTitle('- [26-11-07] 很短')).toBe('');
  });
  it('加在日期后面，已有【】的不重复加', () => {
    const r = anchorEntries(['- [26-11-07] 他发黑化视频，修 bug 重发', '- [26-11-08] 【已有锚点】内容']);
    expect(r.lines[0]).toMatch(/^- \[26-11-07\] 【.+】他发黑化视频/);
    expect(r.lines[1]).toBe('- [26-11-08] 【已有锚点】内容');
    expect(r.anchored).toBe(1);
  });
  it('非条目行原样保留', () => {
    const r = anchorEntries(['<!-- 注释 -->', '']);
    expect(r.anchored).toBe(0);
  });
  it('跑两次不会叠加（幂等）', () => {
    const once = anchorEntries(['- [26-11-07] 他发黑化视频，修 bug 重发']).lines;
    const twice = anchorEntries(once).lines;
    expect(twice[0]).toBe(once[0]);
  });
});
