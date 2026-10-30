
const fs = require('fs');
const raw = fs.readFileSync(process.env.TEMP + '/msgs.json', 'utf8');
const start = raw.indexOf('[');
const data = JSON.parse(raw.slice(start));
const rows = data[0].results;
const out = [];
for (const r of rows) {
  const c = r.c || '';
  const hits = [...c.matchAll(/(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*([0-9一二两三四五六七八九十]{1,3})\s*点(半|多|零几|[0-9]{1,2}分)?/g)].map((m) => m[0]);
  if (!hits.length) continue;
  out.push('#'.concat(r.id, ' ', r.created_at, ' | ', hits.join(' / '), ' | ', c.replace(/\n/g, ' ').slice(0, 70)));
}
console.log('rows=' + rows.length + ' withTime=' + out.length);
console.log(out.join('\n'));
