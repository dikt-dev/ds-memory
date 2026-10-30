import { describe, expect, it } from 'vitest';
import { createStreamScrubber } from './anti-ai-flavor';

const TEXT = '[10-30 09:47]够不够不是拍脑袋说的呀。你凭啥觉得够了条目现在多少量、reindex跑一次几秒，你摸过没？';

function run(chunks: string[]) {
  const s = createStreamScrubber();
  let out = '';
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  return out;
}

describe('probe time label leaks', () => {
  it('whole', () => { expect(run([TEXT])).not.toContain('['); });
  it('two halves', () => {
    for (let i = 1; i < TEXT.length; i++) {
      const r = run([TEXT.slice(0, i), TEXT.slice(i)]);
      if (r.includes('[')) throw new Error('LEAK at split ' + i + ': ' + JSON.stringify(r.slice(0, 40)));
    }
  });
  it('char1 then char2 then rest', () => {
    const r = run([TEXT[0], TEXT.slice(1, 2), TEXT.slice(2)]);
    expect(r).not.toContain('[');
  });
  it('leading newline', () => { expect(run(['\n' + TEXT])).not.toContain('['); });
});