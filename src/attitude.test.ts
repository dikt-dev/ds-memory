import { describe, expect, it } from 'vitest';
import {
  AFFINITY_STAGES,
  INTIMACY_STAGES,
  applyMoodDelta,
  buildRelationStatus,
  describeAttitude,
  driftMood,
  stageIndex,
} from './attitude';

describe('阶段划分', () => {
  it('好感度阶段边界', () => {
    expect(stageIndex(0, AFFINITY_STAGES)).toBe(0);
    expect(stageIndex(200, AFFINITY_STAGES)).toBe(1);
    expect(stageIndex(800, AFFINITY_STAGES)).toBe(4);
  });

  it('亲密度阶段边界', () => {
    expect(stageIndex(0, INTIMACY_STAGES)).toBe(0);
    expect(stageIndex(350, INTIMACY_STAGES)).toBe(2);
    expect(stageIndex(850, INTIMACY_STAGES)).toBe(4);
  });
});

describe('buildRelationStatus —— 三维综合', () => {
  it('默认值：熟悉 + 认识 + 平静', () => {
    const s = buildRelationStatus(500, 300, 500);
    expect(s.affinity_stage).toBe('熟悉');
    expect(s.intimacy_stage).toBe('认识');
    expect(s.mood_stage).toBe('平静');
    expect(s.base_attitude).toBe('友好自然');
    expect(s.attitude).toBe('友好自然'); // 平静不改变基调
    expect(s.mood_effect).toBe('neutral');
  });

  it('心情好 → 态度更热', () => {
    const base = buildRelationStatus(500, 300, 500);
    const happy = buildRelationStatus(500, 300, 900);
    expect(happy.mood_stage).toBe('雀跃');
    expect(happy.mood_effect).toBe('warmer');
    expect(happy.attitude).not.toBe(base.attitude);
  });

  it('心情差 → 态度更冷', () => {
    const sad = buildRelationStatus(500, 300, 100);
    expect(sad.mood_stage).toBe('低落');
    expect(sad.mood_effect).toBe('cooler');
  });

  it('低关系 + 高心情 也不会变成灵魂默契（心情只做微调）', () => {
    const s = buildRelationStatus(100, 100, 1000);
    expect(s.attitude).not.toBe('灵魂默契');
    // 低关系下最热也只能到"礼貌但保持距离"这个档位
    expect(['冷淡疏离', '客气而疏远', '礼貌但保持距离', '礼貌客气', '有分寸的友好']).toContain(s.attitude);
  });

  it('高关系 + 低心情 仍保持亲密底色', () => {
    const s = buildRelationStatus(900, 900, 0);
    expect(s.base_attitude).toBe('灵魂默契');
    expect(s.mood_effect).toBe('cooler');
    // 心情差会让它从"灵魂默契"降到稍冷但仍亲密档
    expect(['亲密无间', '深深信任', '亲密交心', '亲密熟络']).toContain(s.attitude);
  });

  it('数值越界钳制到 0~1000', () => {
    const s = buildRelationStatus(-10, 2000, 5000);
    expect(s.affinity).toBe(0);
    expect(s.intimacy).toBe(1000);
    expect(s.mood).toBe(1000);
  });
});

describe('describeAttitude', () => {
  it('包含态度与三个数值', () => {
    const s = describeAttitude(500, 300, 500);
    expect(s).toContain('友好自然');
    expect(s).toContain('500/1000');
    expect(s).toContain('300/1000');
  });

  it('心情影响时标注', () => {
    expect(describeAttitude(500, 300, 900)).toContain('心情好');
    expect(describeAttitude(500, 300, 100)).toContain('心情差');
  });
});

describe('心情变化', () => {
  it('applyMoodDelta 单日 ±80 截断', () => {
    expect(applyMoodDelta(500, 900)).toBe(580);
    expect(applyMoodDelta(500, 100)).toBe(420);
    expect(applyMoodDelta(0, -100)).toBe(0);
    expect(applyMoodDelta(1000, 2000)).toBe(1000);
  });

  it('driftMood 向基线回归', () => {
    expect(driftMood(900, 500, 0.1)).toBe(860);
    expect(driftMood(100, 500, 0.1)).toBe(140);
    expect(driftMood(500, 500, 0.1)).toBe(500);
  });
});
