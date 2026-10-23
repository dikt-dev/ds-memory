import { describe, expect, it } from 'vitest';
import { recentFilesBlock, recordFiles } from './recent-files';
import { isPaused } from './webproactive';

/** 最小 KV 替身：只实现 get(…, 'json') 与 put。 */
function fakeKv(store = new Map<string, string>()) {
  return {
    store,
    kv: {
      // 原样存字符串（和真 KV 一样），只有要 'json' 时才反序列化
      get: async (key: string, type?: string) => {
        if (!store.has(key)) return null;
        const v = store.get(key) as string;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    } as unknown as KVNamespace,
  };
}

const envOf = (kv: KVNamespace) => ({ KV: kv }) as never;

describe('recent-files 文件沉淀', () => {
  it('没有文件时返回 null', async () => {
    const { kv } = fakeKv();
    expect(await recentFilesBlock(envOf(kv), new Date())).toBeNull();
  });

  it('空/非法输入直接忽略', async () => {
    const { kv, store } = fakeKv();
    await recordFiles(envOf(kv), []);
    await recordFiles(envOf(kv), [{ name: '' }, { chars: 3 }, 'x']);
    expect(store.size).toBe(0);
  });

  it('记录后能生成提示词块', async () => {
    const { kv } = fakeKv();
    await recordFiles(envOf(kv), [{ name: '季度报表.xlsx', chars: 1200 }]);
    const block = await recentFilesBlock(envOf(kv), new Date());
    expect(block).toContain('最近发过的文件');
    expect(block).toContain('季度报表.xlsx');
    expect(block).toContain('1200');
  });

  it('同名文件只保留最新一条', async () => {
    const { kv, store } = fakeKv();
    await recordFiles(envOf(kv), [{ name: 'a.pdf', chars: 100 }]);
    await recordFiles(envOf(kv), [{ name: 'a.pdf', chars: 200 }]);
    const list = JSON.parse(store.get('files:recent') as string) as Array<{
      name: string;
      chars: number;
    }>;
    expect(list.filter((f) => f.name === 'a.pdf')).toHaveLength(1);
    expect(list[0].chars).toBe(200);
  });

  it('最多保留 8 条', async () => {
    const { kv, store } = fakeKv();
    for (let i = 0; i < 12; i++) {
      await recordFiles(envOf(kv), [{ name: `f${i}.pdf`, chars: i }]);
    }
    const list = JSON.parse(store.get('files:recent') as string) as unknown[];
    expect(list).toHaveLength(8);
  });

  it('超过 7 天的记录不再展示', async () => {
    const { kv, store } = fakeKv();
    const old = new Date(Date.now() - 9 * 86400000).toISOString();
    store.set('files:recent', JSON.stringify([{ name: 'old.pdf', chars: 10, at: old }]));
    expect(await recentFilesBlock(envOf(kv), new Date())).toBeNull();
  });

  it('不传 chars 时不显示字数', async () => {
    const { kv } = fakeKv();
    await recordFiles(envOf(kv), [{ name: 'x.txt' }]);
    const block = (await recentFilesBlock(envOf(kv), new Date())) ?? '';
    expect(block).toContain('x.txt');
    expect(block).not.toContain('字）');
  });
});

describe('主动消息暂停（/退订）', () => {
  it('没有暂停记录时不暂停', async () => {
    const { kv } = fakeKv();
    expect(await isPaused(envOf(kv), new Date())).toBe(false);
  });

  it('未到期时暂停', async () => {
    const { kv } = fakeKv();
    const until = new Date(Date.now() + 86400000).toISOString();
    await kv.put('proactive:paused_until', until);
    expect(await isPaused(envOf(kv), new Date())).toBe(true);
  });

  it('已过期自动恢复', async () => {
    const { kv } = fakeKv();
    await kv.put('proactive:paused_until', new Date(Date.now() - 1000).toISOString());
    expect(await isPaused(envOf(kv), new Date())).toBe(false);
  });

  it('脏数据不会误伤', async () => {
    const { kv } = fakeKv();
    await kv.put('proactive:paused_until', 'not-a-date');
    expect(await isPaused(envOf(kv), new Date())).toBe(false);
  });
});
