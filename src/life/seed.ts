/**
 * 可复现随机。
 *
 * 同一天同一个种子必须给出同一天的计划——否则「昨天她说在追番第 3 集，
 * 今天重算变成第 5 集」，连续性和日记全对不上。
 *
 * 用 mulberry32：32 位状态、速度快、分布够用，不需要引入依赖。
 */

/** 把任意字符串折成一个 32 位种子（FNV-1a）。 */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max] 整数 */
  int(min: number, max: number): number;
  /** 数组里挑一个 */
  pick<T>(items: readonly T[]): T;
  /** 按权重挑一个；权重全为 0 时返回 null */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T | null;
  /** 概率为 p 时返回 true */
  chance(p: number): boolean;
}

export function makeRng(seed: number | string): Rng {
  let state = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items, weightOf) => {
      const total = items.reduce((sum, item) => sum + Math.max(0, weightOf(item)), 0);
      if (total <= 0) return null;
      let roll = next() * total;
      for (const item of items) {
        roll -= Math.max(0, weightOf(item));
        if (roll <= 0) return item;
      }
      return items[items.length - 1] ?? null;
    },
    chance: (p) => next() < p,
  };
}
