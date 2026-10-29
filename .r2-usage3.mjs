
import { AwsClient } from 'aws4fetch';
const c = new AwsClient({ accessKeyId: process.env.R2_AK, secretAccessKey: process.env.R2_SK, service: 's3', region: 'auto' });
const base = process.env.R2_EP.replace(/\/$/, ''), bucket = process.env.R2_BUCKET;
async function listAll(prefix) {
  let token = null, count = 0, bytes = 0, oldest = null, newest = null;
  do {
    const u = new URL(base + '/' + bucket);
    u.searchParams.set('list-type', '2');
    if (prefix) u.searchParams.set('prefix', prefix);
    u.searchParams.set('max-keys', '1000');
    if (token) u.searchParams.set('continuation-token', token);
    const r = await c.fetch(u.toString());
    if (!r.ok) { console.log(prefix || '(all)', 'HTTP', r.status, (await r.text()).slice(0, 120)); return null; }
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const b = m[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(b)?.[1] ?? 0);
      const lm = /<LastModified>([^<]+)<\/LastModified>/.exec(b)?.[1] ?? '';
      count++; bytes += size;
      if (!oldest || lm < oldest) oldest = lm;
      if (!newest || lm > newest) newest = lm;
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
  } while (token);
  return { count, bytes, oldest, newest };
}
const all = await listAll('');
if (all) console.log('TOTAL'.padEnd(11), 'n=' + String(all.count).padStart(5), (all.bytes / 1048576).toFixed(1).padStart(9) + 'MB');
for (const p of ['videos/', 'gifs/', 'images/', 'audio/', 'sheets/', 'chat_logs/', 'context/']) {
  const r = await listAll(p);
  if (r && r.count > 0) console.log(p.padEnd(11), 'n=' + String(r.count).padStart(5), (r.bytes / 1048576).toFixed(1).padStart(9) + 'MB', 'oldest=' + (r.oldest ?? '-').slice(0, 10), 'newest=' + (r.newest ?? '-').slice(0, 10));
  else if (r) console.log(p.padEnd(11), 'n=    0');
}
