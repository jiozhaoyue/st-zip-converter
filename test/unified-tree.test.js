import { describe, expect, it } from 'vitest';
import * as zip from '@zip.js/zip.js';
import { zipIo } from '../src/core/zip-io.js';
import { generatePlan } from '../src/core/plan-preview.js';
import { TARGETS } from '../src/core/transform.js';
import { lEntries } from '../fixtures/gen.js';

async function createFixtureBlob(entries) {
  const blobWriter = new zip.BlobWriter('application/zip');
  const writer = new zip.ZipWriter(blobWriter);
  for (const [name, data] of entries) {
    await writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)));
  }
  await writer.close();
  return blobWriter.getData();
}

/**
 * 统一文件树聚合规则（与 category-filter.js 渲染逻辑同源）：
 * - 类目勾选框 = 全选/半选/未选聚合态
 * - selection[cat] = 该类目"至少一个文件被勾选"
 * - 文件级差异 → excludedPaths
 */
function aggregateTreeState(plan, { deselectedCategories = [], excludedPaths = new Set() } = {}) {
  const selection = {};
  const effectiveExcluded = new Set(excludedPaths);

  for (const [key, data] of Object.entries(plan.categories)) {
    if ((data.count || 0) === 0) {
      selection[key] = false;
      continue;
    }
    const items = data.items || [];
    if (items.length === 0) {
      selection[key] = !deselectedCategories.includes(key);
      continue;
    }
    // 树派生：类目下至少一个文件被勾选（排除集与类目反选共同作用）
    const anySelected = items.some((it) => {
      if (deselectedCategories.includes(it.category)) return false;
      if (it.rawAction === 'DROP') return false;
      return !effectiveExcluded.has(it.sourcePath) && !effectiveExcluded.has(it.hubPath);
    });
    selection[key] = anySelected;
  }
  return { selection, excludedPaths: effectiveExcluded };
}

describe('统一文件树勾选聚合 (selection/excludedPaths 同树派生)', () => {
  it('全选默认态：非空且含可写条目的类目 selection=true，excludedPaths 为空', async () => {
    const blob = await createFixtureBlob(lEntries());
    const plan = await generatePlan(blob, TARGETS.PT, { io: zipIo });
    const { selection, excludedPaths } = aggregateTreeState(plan);

    for (const [key, data] of Object.entries(plan.categories)) {
      if ((data.count || 0) > 0 && (data.items || []).some((it) => it.rawAction !== 'DROP')) {
        expect(selection[key]).toBe(true);
      }
    }
    // DROP-only 类目（cache/backups 等默认不可写）派生为 false
    expect(selection.cache).toBe(false);
    expect(excludedPaths.size).toBe(0);
  });

  it('子文件排除 → 父类目仍为 true（半选态）且 excludedPaths 记录差异', async () => {
    const blob = await createFixtureBlob(lEntries());
    const plan = await generatePlan(blob, TARGETS.PT, { io: zipIo });

    // 找一个有多个条目的类目，排除其第一个文件
    const multiCat = Object.entries(plan.categories).find(([, d]) => (d.items?.length || 0) > 1);
    expect(multiCat).toBeDefined();
    const [catKey, catData] = multiCat;
    const firstItem = catData.items[0];

    const { selection, excludedPaths } = aggregateTreeState(plan, {
      excludedPaths: new Set([firstItem.sourcePath]),
    });

    // 其他文件仍在 → 类目保持勾选（半选）
    expect(selection[catKey]).toBe(true);
    expect(excludedPaths.has(firstItem.sourcePath)).toBe(true);
    expect(catData.items.length - 1).toBeGreaterThan(0);
  });

  it('全部子文件被排除 → 父类目派生为 false（等价取消勾选）', async () => {
    const blob = await createFixtureBlob(lEntries());
    const plan = await generatePlan(blob, TARGETS.PT, { io: zipIo });

    const [catKey, catData] = Object.entries(plan.categories).find(([, d]) => (d.items?.length || 0) > 1);
    const allPaths = catData.items.map((it) => it.sourcePath);

    const { selection } = aggregateTreeState(plan, {
      excludedPaths: new Set(allPaths),
    });
    expect(selection[catKey]).toBe(false);
  });

  it('类目级取消勾选 → selection=false 且文件不进产物（convert 验证）', async () => {
    const blob = await createFixtureBlob(lEntries());
    const plan = await generatePlan(blob, TARGETS.PT, { io: zipIo });

    // 取消 chats 类目
    const deselected = ['chats'];
    const { selection } = aggregateTreeState(plan, { deselectedCategories: deselected });
    expect(selection.chats).toBe(false);

    // convert 以派生 selection 过滤：chats 条目全部 filtered
    const { convert } = await import('../src/core/transform.js');
    const report = await convert(blob, new zip.BlobWriter('application/zip'), {
      target: TARGETS.PT,
      io: zipIo,
      selection,
    });
    const json = report.toJSON();
    expect(json.totals.filtered).toBeGreaterThanOrEqual(1);
    expect(json.filtered.some((f) => f.category === 'chats' || f.path.startsWith('chats/'))).toBe(true);
  });

  it('树勾选联动 convert：excludedPaths 条目不进产物，其余正常', async () => {
    const blob = await createFixtureBlob(lEntries());
    const plan = await generatePlan(blob, TARGETS.PT, { io: zipIo });

    const settingsItem = plan.categories.settings?.items?.find((it) => it.sourcePath.endsWith('settings.json'))
      || Object.values(plan.categories).flatMap((c) => c.items).find((it) => it.sourcePath.endsWith('settings.json'));
    expect(settingsItem).toBeDefined();

    const { convert } = await import('../src/core/transform.js');
    const { report } = {
      report: await convert(blob, new zip.BlobWriter('application/zip'), {
        target: TARGETS.PT,
        io: zipIo,
        selection: aggregateTreeState(plan).selection,
        excludedPaths: new Set([settingsItem.sourcePath]),
      }),
    };
    const json = report.toJSON();
    expect(json.filtered.some((f) => f.path === settingsItem.hubPath || f.reason === 'item-excluded')).toBe(true);
  });
});
