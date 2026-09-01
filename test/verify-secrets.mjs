// AC6 校验:每个产物包的 secrets.json 与其源包字节一致;顺带核对包内条目数与报告一致。
// 用法:node test/verify-secrets.mjs
import { ZipReader } from '../src/core/read.js';

const CASES = [
  { source: 'default-user-2026-08-25-172056.zip', tag: 'l', secretsPath: 'secrets.json' },
  { source: 'tauritavern-data-20260825-100035.zip', tag: 'tt', secretsPath: 'data/default-user/secrets.json' },
];

const TARGET_SECRETS = { st: 'secrets.json', l: 'secrets.json', tt: 'data/default-user/secrets.json', pt: 'data/default-user/secrets.json' };

async function extractEntry(zipPath, wanted) {
  const reader = await ZipReader.open(zipPath);
  try {
    for await (const entry of reader.entries()) {
      if (entry.fileName === wanted) {
        const data = await entry.read();
        return data;
      }
      entry.skip();
    }
    return null;
  } finally {
    await reader.close();
  }
}

let failures = 0;
for (const item of CASES) {
  const sourceSecrets = await extractEntry(item.source, item.secretsPath);
  if (!sourceSecrets) {
    console.error(`FAIL 源包 ${item.source} 不含 ${item.secretsPath}`);
    failures += 1;
    continue;
  }
  for (const target of ['st', 'l', 'tt', 'pt']) {
    const outPath = `out/real-${item.tag}-to-${target}.zip`;
    const got = await extractEntry(outPath, TARGET_SECRETS[target]);
    if (!got) {
      console.error(`FAIL ${outPath} 缺 secrets(${TARGET_SECRETS[target]})`);
      failures += 1;
      continue;
    }
    if (Buffer.compare(got, sourceSecrets) !== 0) {
      console.error(`FAIL ${outPath} secrets 字节不一致`);
      failures += 1;
      continue;
    }
    const report = JSON.parse((await import('node:fs')).readFileSync(`out/real-${item.tag}-to-${target}.json`, 'utf8'));
    const reader = await ZipReader.open(outPath);
    const count = reader.entryCount;
    await reader.close();
    const expected = report.totals.copied + report.totals.synthesized;
    console.log(
      `${count === expected ? 'OK  ' : 'FAIL'} ${outPath} secrets 一致 (${sourceSecrets.length}B), 条目 ${count}/${expected}`,
      (report.stats.peakRssBytes / 1048576 | 0) + 'MiB',
      (report.stats.elapsedMs / 1000).toFixed(1) + 's',
    );
    if (count !== expected) failures += 1;
  }
}
process.exit(failures > 0 ? 1 : 0);
