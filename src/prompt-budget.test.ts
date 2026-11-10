/**
 * 提示词预算表（2026-11-10）。
 *
 * 目的：回答「提示词是不是太多、重点会不会被淹掉」——不看感觉，看每个区块的字符数、
 * 位置，以及**最后 800 字里到底有几条指令**。
 *
 * 默认跳过（CI 不受影响）：
 *   $env:PROMPT_BUDGET="1"; npx vitest run src/prompt-budget.test.ts
 * 需要本地有 .tmp-banter\persona.md 与 memory.md（只读拉取，见 banter-probe.test.ts 头注释）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildDayContext } from './holidays';
import { buildSystemPromptSplit } from './prompt';
import { buildVoiceDirective, buildVoiceTail, type VoiceMode } from './voice';

const ENV: Record<string, string | undefined> =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const ENABLED = ENV.PROMPT_BUDGET === '1';
const DIR = ENV.BANTER_DIR || '.tmp-banter';
const MODE = (ENV.PB_MODE || 'lite') as VoiceMode;

function readDoc(name: string): string {
  const path = DIR + '/' + name;
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** 记忆分区字数（只统计标题下的正文） */
function sectionsOf(text: string): Array<{ name: string; chars: number }> {
  const out: Array<{ name: string; chars: number }> = [];
  let name = '(开头)';
  let buf: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      out.push({ name, chars: buf.join('\n').trim().length });
      name = line.trim().replace(/^##\s+/, '');
      buf = [];
    } else {
      buf.push(line);
    }
  }
  out.push({ name, chars: buf.join('\n').trim().length });
  return out.filter((s) => s.chars > 0);
}

describe.skipIf(!ENABLED)('提示词预算', () => {
  it('分区块统计 + 末尾指令检查（' + MODE + '）', () => {
    const persona = readDoc('persona.md');
    const memory = readDoc('memory.md');
    const ctx = buildDayContext('2026-11-10');
    const voice = buildVoiceDirective(600, MODE);
    const voiceTail = buildVoiceTail(MODE);

    const split = buildSystemPromptSplit({
      now: new Date('2026-11-10T03:10:00Z'),
      ctx,
      memory,
      channel: 'web',
      voice,
      voiceTail,
    });

    // persona 是单独一条 system 消息，但同样占她的注意力，一起算
    const systemChars = split.stable.length + split.volatile.length + persona.length;
    const lines = [split.stable, split.volatile].join('\n').split('\n');
    // 指令 = 以「- 」开头且不是记忆条目（记忆条目是「- [日期] …」）
    const isInstr = (l: string) => l.trimStart().startsWith('- ') && !/^-\s*\[/.test(l.trimStart());
    const instr = lines.filter(isInstr);
    const memoryLines = lines.filter((l) => /^-\s*\[/.test(l.trimStart()));
    const last800 = lines.join('\n').slice(-800);
    const tailInstr = last800.split('\n').filter(isInstr);

    console.log('\n===== 提示词预算（' + MODE + '）=====');
    console.log('稳定前缀 ' + split.stable.length + ' / 易变后缀 ' + split.volatile.length + ' / persona ' + persona.length);
    console.log('系统提示词合计 ' + systemChars + ' 字（≈' + Math.round(systemChars / 1.5) + ' token）');
    console.log('指令行 ' + instr.length + ' 条 / 记忆条目 ' + memoryLines.length + ' 条（提示词正文 ' + lines.length + ' 行）');
    console.log('memory.md 原文 ' + memory.length + ' 字');
    console.log('最后 800 字里的指令 ' + tailInstr.length + ' 条：');
    for (const l of tailInstr) console.log('  ' + l.trim().slice(0, 60));
    console.log('\n记忆分区：');
    for (const s of sectionsOf(memory)) console.log('  ' + s.name + ' ' + s.chars + ' 字');

    // 结构性断言：末尾必须能读到「长短」和「换事」两条
    expect(split.volatile).toContain('长短由你');
    expect(split.volatile).toContain('三轮');
    expect(split.stable).not.toContain('长短由你');
    expect(systemChars).toBeGreaterThan(0);
  }, 60_000);
});
