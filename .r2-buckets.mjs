
import { AwsClient } from 'aws4fetch';
const c = new AwsClient({ accessKeyId: process.env.R2_AK, secretAccessKey: process.env.R2_SK, service: 's3', region: 'auto' });
const base = process.env.R2_EP.replace(/\/$/, '');
const r = await c.fetch(base + '/');
console.log('root list status', r.status);
const xml = await r.text();
console.log(xml.match(/<Name>([^<]+)<\/Name>/g)?.join(', ').slice(0, 400) ?? xml.slice(0, 300));
