import { describe, expect, it } from 'vitest';
import { PROJECTION_MAX_BYTES, validateProjection } from './memory-projection';

const before = '# 长期记忆\n\n## 人物底色\n- 名字=阿澈\n\n## 称呼与关系\n- 好感度：620\n';

describe('validateProjection', () => {
  it('正常投影通过', () => {
    expect(validateProjection(before, `${before}\n## 关于用户\n- [26-10-01] 城市=杭州\n`)).toEqual([]);
  });

  it('丢失标题/核心区/超预算会拒绝', () => {
    expect(validateProjection(before, '')).toContain('projection empty');
    expect(validateProjection(before, '## 人物底色\n- 名字=阿澈')).toContain('missing memory title');
    expect(validateProjection(before, '# 长期记忆\n\n## 关于用户\n')).toContain(
      'pinned section lost: ## 人物底色',
    );
    expect(
      validateProjection(before, `# 长期记忆\n${'x'.repeat(PROJECTION_MAX_BYTES)}`),
    ).toContain(`projection exceeds ${PROJECTION_MAX_BYTES} bytes`);
  });
});
