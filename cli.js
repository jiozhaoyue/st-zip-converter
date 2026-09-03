#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { convert, TARGETS } from './src/core/transform.js';
import { nodeIo, detectLayout } from './src/io/node-io.js';

const USAGE = `tavern-convert — 酒馆系(SillyTavern/Luker/PureTavern/TauriTavern)数据包互转

用法:
  tavern-convert <输入.zip> --to <st|l|tt|pt> [-o 输出.zip] [选项]
  tavern-convert detect <输入.zip>                 # 只识别布局

选项:
  --to <平台>      目标平台:st | l | tt | pt(pt 目标为 TT 布局,供 PT 直接导入)
  -o, --out <路径>  输出 zip 路径(默认与输入同目录:<名字>-<目标>.zip)
  --keep-all        保留派生缓存与 TT 私有目录(默认丢弃并在报告中列明)
  --dry-run         只产出转换报告,不写文件
  --json            报告以 JSON 输出(含峰值内存统计)
  -h, --help        显示本说明

示例:
  tavern-convert default-user-xxx.zip --to pt
  tavern-convert tauritavern-data.zip --to l -o for-luker.zip --dry-run
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      out: { type: 'string', short: 'o' },
      'keep-all': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }

  if (positionals[0] === 'detect') {
    const file = positionals[1];
    if (!file) failUsage('detect 模式需要 <输入.zip>');
    const result = await detectLayout(file);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${file} -> ${result.layout} (${result.evidence})\n`);
    }
    return;
  }

  const input = positionals[0];
  if (!values.to || !Object.values(TARGETS).includes(values.to)) {
    failUsage(`--to 必须是 ${Object.values(TARGETS).join('|')} 之一`);
  }

  const output = values.out
    ?? path.join(
      path.dirname(input),
      `${path.basename(input, '.zip').replace(/\.ZIP$/, '')}-${values.to}.zip`,
    );

  const startedAt = Date.now();
  const report = await convert(input, output, {
    target: values.to,
    keepAll: values['keep-all'],
    dryRun: values['dry-run'],
    io: nodeIo,
  });
  const elapsedMs = Date.now() - startedAt;
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;

  if (values.json) {
    const payload = {
      ...report.toJSON(),
      stats: {
        elapsedMs,
        peakRssBytes,
        outputFile: values['dry-run'] ? null : output,
        dryRun: Boolean(values['dry-run']),
      },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const header = values['dry-run'] ? '[DRY RUN] ' : '';
    process.stdout.write(`${header}${report.toHuman()}\n`);
    process.stdout.write(
      `\n耗时 ${(elapsedMs / 1000).toFixed(1)}s,峰值内存 ${(peakRssBytes / 1048576).toFixed(0)} MiB`
      + (values['dry-run'] ? '' : `,输出: ${output}`) + '\n',
    );
  }
}

function failUsage(message) {
  process.stderr.write(`错误: ${message}\n\n${USAGE}`);
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`转换失败: ${error?.stack ?? error}\n`);
  process.exit(1);
});
