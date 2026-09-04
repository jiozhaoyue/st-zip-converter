/**
 * st-zip-converter 核心控制器 (ESM)
 * 具备三位一体自适应能力:
 * 1. 独立运行 (本地开发服务 / GitHub Pages)
 * 2. SillyTavern / Luker 第三方扩展插件模式
 */

import { runConversionTask } from './src/core/worker-client.js';
import { inspectArchive } from './src/core/inspect.js';
import {
  setupCategoryFilter,
  renderCategoryStats,
  getSelectionState,
  resetCategoryFilter,
} from './src/ui/category-filter.js';
import { detectHost, fetchHostBackup, restoreToLuker, registerMenuButton } from './src/ui/host-bridge.js';
import { setupFileDrop } from './src/ui/file-drop.js';
import { createViewController } from './src/ui/view.js';

function formatTimestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function main() {
  const host = detectHost();
  const view = createViewController();

  // 初始化类目过滤器组件
  setupCategoryFilter();

  // 1. 宿主环境识别与 Badge 标识
  const envBadge = document.getElementById('env-badge');
  const hostExportCard = document.getElementById('host-export-card');
  const btnRestoreLuker = document.getElementById('btn-restore-luker');
  const targetSelect = document.getElementById('target-select');
  const keepAllCheck = document.getElementById('keep-all-check');
  const btnConvert = document.getElementById('btn-convert');

  if (envBadge) {
    if (host.platform === 'st') {
      envBadge.textContent = 'SillyTavern 插件模式';
      envBadge.style.color = 'var(--accent-st)';
      envBadge.style.borderColor = 'var(--accent-st)';
    } else if (host.platform === 'luker') {
      envBadge.textContent = 'Luker 插件模式';
      envBadge.style.color = 'var(--accent-luker)';
      envBadge.style.borderColor = 'var(--accent-luker)';
    } else {
      envBadge.textContent = '独立 Web 模式';
    }
  }

  // 2. 插件态界面激活
  if (host.isPlugin) {
    if (hostExportCard) hostExportCard.style.display = 'block';
    if (host.platform === 'luker' && btnRestoreLuker) {
      btnRestoreLuker.style.display = 'inline-block';
    }
    // 默认目标平台贴合宿主环境
    if (targetSelect) {
      targetSelect.value = host.platform === 'luker' ? 'l' : 'st';
    }
    // 注册酒馆顶部/侧边扩展栏按钮
    registerMenuButton(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // 3. 宿主一键导出快捷按钮组处理
  const exportButtons = document.querySelectorAll('.btn-export');
  exportButtons.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const target = btn.getAttribute('data-target');
      if (!target) return;

      const targetLabel = btn.querySelector('span')?.textContent ?? target;
      try {
        exportButtons.forEach((b) => (b.disabled = true));
        view.setProgress(5, `正在从 ${host.platform.toUpperCase()} 拉取当前备份包...`);

        const sourceBlob = await fetchHostBackup(host.platform);
        view.setProgress(20, `备份数据拉取完毕 (${(sourceBlob.size / 1048576).toFixed(1)} MB)，正在多线程转换...`);

        const { report, resultBlob } = await runConversionTask({
          source: sourceBlob,
          target,
          options: {
            keepAll: keepAllCheck ? keepAllCheck.checked : false,
          },
          onProgress: (cur, total, name) => {
            const pct = total > 0 ? 20 + Math.round((cur / total) * 75) : 50;
            view.setProgress(pct, `正在写入 [${cur}/${total}]: ${name}`);
          },
        });

        view.setProgress(100, `转换完成！已导出为 ${targetLabel}`);

        const filename = `${host.platform}-to-${target}-${formatTimestamp()}.zip`;
        view.triggerDownload(resultBlob, filename);
        view.renderReport(report);
      } catch (err) {
        view.setProgress(100, `导出失败: ${err.message}`);
        console.error(err);
      } finally {
        exportButtons.forEach((b) => (b.disabled = false));
      }
    });
  });

  // 4. 外部 Zip 拖拽与转换交互
  let currentFile = null;
  let lastConvertedBlob = null;

  const dropHandler = setupFileDrop({
    dropzoneEl: document.getElementById('dropzone'),
    fileInputEl: document.getElementById('file-input'),
    mainTextEl: document.getElementById('drop-main-text'),
    subTextEl: document.getElementById('drop-sub-text'),
    onFileReady: async (file, detection) => {
      currentFile = file;
      btnConvert.disabled = false;
      // 智能预选：如果源是 ST，默认目标设为 L 或 TT
      if (detection.layout === 'st' && targetSelect) targetSelect.value = 'l';
      if (detection.layout === 'tt' && targetSelect) targetSelect.value = 'pt';

      // 毫秒级中央目录预检并展开类目与脱敏选择器
      try {
        const inspectResult = await inspectArchive(file);
        renderCategoryStats(inspectResult);
      } catch (err) {
        console.warn('中央目录预检失败:', err);
      }
    },
    onError: (err) => {
      btnConvert.disabled = true;
      resetCategoryFilter();
      console.error(err);
    },
  });

  // 开始转换外部 Zip
  btnConvert.addEventListener('click', async () => {
    if (!currentFile) return;
    const target = targetSelect.value;
    const keepAll = keepAllCheck.checked;
    const selection = getSelectionState();

    try {
      btnConvert.disabled = true;
      if (btnRestoreLuker) btnRestoreLuker.disabled = true;
      view.setProgress(5, '正在启动异步 Web Worker 线程处理数据包...');

      const { report, resultBlob } = await runConversionTask({
        source: currentFile,
        target,
        options: {
          keepAll,
          selection,
        },
        onProgress: (cur, total, name) => {
          const pct = total > 0 ? 10 + Math.round((cur / total) * 85) : 50;
          view.setProgress(pct, `多线程处理中 [${cur}/${total}]: ${name}`);
        },
      });

      lastConvertedBlob = resultBlob;
      view.setProgress(100, '转换完成！已触发浏览器下载');

      const baseName = currentFile.name.replace(/\.zip$/i, '');
      const outName = `${baseName}-to-${target}-${formatTimestamp()}.zip`;
      view.triggerDownload(lastConvertedBlob, outName);
      view.renderReport(report);

      if (host.platform === 'luker' && btnRestoreLuker && target === 'l') {
        btnRestoreLuker.disabled = false;
      }
    } catch (err) {
      view.setProgress(100, `转换失败: ${err.message}`);
      console.error(err);
    } finally {
      btnConvert.disabled = false;
    }
  });

  // (Luker 专享) 直接恢复到当前用户
  if (btnRestoreLuker) {
    btnRestoreLuker.addEventListener('click', async () => {
      if (!lastConvertedBlob) return;
      try {
        btnRestoreLuker.disabled = true;
        view.setProgress(50, '正在向 Luker 发送恢复请求...');
        await restoreToLuker(lastConvertedBlob);
        view.setProgress(100, '已成功恢复至 Luker 当前用户！请刷新页面查看。');
      } catch (err) {
        view.setProgress(100, `恢复失败: ${err.message}`);
        console.error(err);
      } finally {
        btnRestoreLuker.disabled = false;
      }
    });
  }

  console.log(`[st-zip-converter] 初始化就绪 (环境: ${host.platform})`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
