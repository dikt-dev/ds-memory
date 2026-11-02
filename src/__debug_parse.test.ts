import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDiaryOutput } from './src/life/diary';

it('debug parse', () => {
  const t = readFileSync('D:/WorkSpace/.tmp/diary-1101.txt', 'utf8');
  const p = parseDiaryOutput(t);
  console.log('LEN', t.length, 'BYTES', Buffer.byteLength(t));
  console.log('BRACE', t.lastIndexOf('{'));
  console.log('TEXT_LEN', p.text.length, 'SUMMARY', JSON.stringify(p.summary), 'SHARE', p.share);
  console.log('TEXT_TAIL', JSON.stringify(p.text.slice(-40)));
});
