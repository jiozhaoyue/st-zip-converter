import { writeFileSync } from 'node:fs';
import * as zip from '../../../../src/vendor/zip.js';
const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { level: 5 });
await writer.add('characters/seraphina.json', new zip.Uint8ArrayReader(new TextEncoder().encode(JSON.stringify({ name: 'Seraphina', description: 'test card', first_mes: 'hi' }))));
await writer.add('settings.json', new zip.Uint8ArrayReader(new TextEncoder().encode(JSON.stringify({ foo: 'bar' }))));
await writer.add('chats/seraphina/0001.jsonl', new zip.Uint8ArrayReader(new TextEncoder().encode(JSON.stringify({ name: 'User', mes: 'hello' }))));
const data = await writer.close();
writeFileSync(new URL('./e2e-sample-st.zip', import.meta.url), Buffer.from(data));
console.log('generated', data.length);
