/**
 * st-zip-converter 核心控制器 (ESM)
 * 具备三位一体自适应能力:
 * 1. 独立运行 (本地开发服务 / GitHub Pages)
 * 2. SillyTavern / Luker 第三方扩展插件模式
 * 3. 具备浏览器 IndexedDB 工作区持久化、完全扫描与单项穿透预览选择能力
 */

import { runConversionTask, runPlanTask } from './src/core/worker-client.js';
import {
  setupCategoryFilter,
  renderCategoryStats,
  getSelectionState,
  setSelectionState,
  getExcludedPaths,
  setExcludedPaths,
  resetCategoryFilter,
} from './src/ui/category-filter.js';
import {
  saveFile,
  getFile,
  getStorageUsage,
  saveWorkspaceState,
  loadWorkspaceState,
  clearAll,
  isStorageSupported,
} from './src/storage/db.js';
import { renderArchiveManager } from './src/ui/archive-manager.js';
import { resolveFilename, DEFAULT_FILENAME_TEMPLATE } from './src/core/filename-template.js';
import { detectHost, fetchHostBackup, restoreToLuker, registerMenuButton } from './src/ui/host-bridge.js';
import { setupFileDrop } from './src/ui/file-drop.js';
import { createViewController } from './src/ui/view.js';

function formatTimestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

async function main() {
  const host = detectHost();
  const view = createViewController();

  let currentFile = null;
  let currentFileId = null;
  let lastConvertedBlob = null;
  let isPlanning = false;

  // DOM 元素引用
  const envBadge = document.getElementById('env-badge');
  const hostExportCard = document.getElementById('host-export-card');
  const btnRestoreLuker = document.getElementById('btn-restore-luker');
  const targetSelect = document.getElementById('target-select');
  const btnConvert = document.getElementById('btn-convert');

  const workspaceBar = document.getElementById('workspace-bar');
  const workspaceStatusText = document.getElementById('workspace-status-text');
  const btnToggleWorkspace = document.getElementById('btn-toggle-workspace');
  const btnClearWorkspace = document.getElementById('btn-clear-workspace');
  const workspacePanel = document.getElementById('workspace-panel');

  const includeBackupsCheck = document.getElementById('include-backups-check');
  const includeCacheCheck = document.getElementById('include-cache-check');
  const includePrivateCheck = document.getElementById('include-private-check');

  const compressionSelect = document.getElementById('compression-select');
  const filenameTemplateInput = document.getElementById('filename-template-input');

  let workspacePanelOpen = false;

  // 初始化类目过滤器组件
  setupCategoryFilter({
    onSelectionChange: () => {
      refreshPlan();
    },
  });

  // 刷新双文件列表管理组件
  async function refreshArchiveManagerUI() {
    if (!workspacePanel || !workspacePanelOpen) return;
    await renderArchiveManager({
      containerEl: workspacePanel,
      activeFileId: currentFileId,
      onLoadFile: async (fileRecord) => {
        if (!fileRecord?.blob) return;
        currentFile = fileRecord.blob;
        currentFile.name = fileRecord.name;
        currentFileId = fileRecord.id;

        btnConvert.disabled = false;
        if (dropHandler?.setFilename) {
          dropHandler.setFilename(fileRecord.name);
        }
        view.setProgress(0, `已载入数据包：${fileRecord.name} (${formatBytes(fileRecord.size)})`);
        await refreshPlan();
        refreshArchiveManagerUI();
      },
      onListChanged: async () => {
        await updateWorkspaceUI();
      },
    });
  }

  // 展开/折叠双文件列表管理面板
  if (btnToggleWorkspace && workspacePanel) {
    btnToggleWorkspace.addEventListener('click', async () => {
      workspacePanelOpen = !workspacePanelOpen;
      workspacePanel.style.display = workspacePanelOpen ? 'block' : 'none';
      btnToggleWorkspace.textContent = workspacePanelOpen ? '双列表管理 ▴' : '双列表管理 ▾';
      if (workspacePanelOpen) {
        await refreshArchiveManagerUI();
      }
    });
  }

  // 1. 更新工作区状态栏
  async function updateWorkspaceUI() {
    if (!isStorageSupported() || !workspaceBar) return;
    try {
      const usage = await getStorageUsage();
      if (usage.count > 0) {
        workspaceBar.style.display = 'flex';
        if (workspaceStatusText) {
          workspaceStatusText.textContent = `IndexedDB 工作区：已暂存 ${usage.count} 个数据包 (${formatBytes(usage.totalBytes)})`;
        }
      } else {
        workspaceBar.style.display = 'none';
        if (workspacePanel) {
          workspacePanel.style.display = 'none';
          workspacePanelOpen = false;
          if (btnToggleWorkspace) btnToggleWorkspace.textContent = '双列表管理 ▾';
        }
      }
      if (workspacePanelOpen) {
        await refreshArchiveManagerUI();
      }
    } catch (err) {
      console.warn('获取工作区用量失败:', err);
    }
  }

  // 2. 调度完全扫描与动作预测规划
  async function refreshPlan() {
    if (!currentFile || isPlanning) return;
    isPlanning = true;

    try {
      const target = targetSelect ? targetSelect.value : 'l';
      const selection = getSelectionState();
      const excludedPaths = getExcludedPaths();
      const includeBackups = includeBackupsCheck ? includeBackupsCheck.checked : true;
      const includeCache = includeCacheCheck ? includeCacheCheck.checked : false;
      const includeAppPrivate = includePrivateCheck ? includePrivateCheck.checked : false;

      const plan = await runPlanTask({
        source: currentFile,
        target,
        options: {
          selection,
          excludedPaths,
          includeBackups,
          includeCache,
          includeAppPrivate,
        },
      });

      renderCategoryStats(plan);

      // 持久化当前工作区状态
      if (currentFileId) {
        await saveWorkspaceState({
          fileId: currentFileId,
          fileName: currentFile.name,
          target,
          selection,
          excludedPaths: Array.from(excludedPaths),
          includeBackups,
          includeCache,
          includeAppPrivate,
          compressionLevel: compressionSelect ? compressionSelect.value : '5',
          filenameTemplate: filenameTemplateInput ? filenameTemplateInput.value : '',
        });
      }
    } catch (err) {
      console.warn('执行规划预测失败:', err);
    } finally {
      isPlanning = false;
    }
  }

  // 3. 宿主环境识别与 Badge 标识
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

  // 4. 插件态界面激活
  if (host.isPlugin) {
    if (hostExportCard) hostExportCard.style.display = 'block';
    if (host.platform === 'luker' && btnRestoreLuker) {
      btnRestoreLuker.style.display = 'inline-block';
    }
    if (targetSelect) {
      targetSelect.value = host.platform === 'luker' ? 'l' : 'st';
    }
    registerMenuButton(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // 5. 宿主一键导出快捷按钮组处理
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
        view.setProgress(20, `备份数据拉取完毕 (${formatBytes(sourceBlob.size)})，正在多线程转换...`);

        const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;

        const { report, resultBlob } = await runConversionTask({
          source: sourceBlob,
          target,
          options: {
            includeBackups: includeBackupsCheck ? includeBackupsCheck.checked : true,
            includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
            includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
            compressionLevel,
          },
          onProgress: (cur, total, name) => {
            const pct = total > 0 ? 20 + Math.round((cur / total) * 75) : 50;
            view.setProgress(pct, `正在写入 [${cur}/${total}]: ${name}`);
          },
        });

        view.setProgress(100, `转换完成！已导出为 ${targetLabel}`);

        const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
        const filename = resolveFilename(template, {
          sourceName: `${host.platform}-backup`,
          target,
        });

        // 暂存导出产物到 IndexedDB
        try {
          await saveFile({
            name: filename,
            size: resultBlob.size,
            blob: resultBlob,
            layout: target,
            role: 'output',
          });
          await updateWorkspaceUI();
        } catch (e) {
          console.warn('暂存产物失败:', e);
        }

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

  // 6. 外部 Zip 拖拽与转换交互
  const dropHandler = setupFileDrop({
    dropzoneEl: document.getElementById('dropzone'),
    fileInputEl: document.getElementById('file-input'),
    mainTextEl: document.getElementById('drop-main-text'),
    subTextEl: document.getElementById('drop-sub-text'),
    onFileReady: async (file, detection) => {
      currentFile = file;
      btnConvert.disabled = false;

      // 智能预选：如果源是 ST，默认目标设为 L；如果源是 TT，设为 PT
      if (detection.layout === 'st' && targetSelect) targetSelect.value = 'l';
      if (detection.layout === 'tt' && targetSelect) targetSelect.value = 'pt';

      // 异步暂存到 IndexedDB
      try {
        currentFileId = await saveFile({
          name: file.name,
          size: file.size,
          blob: file,
          layout: detection.layout,
          role: 'source',
        });
        await updateWorkspaceUI();
      } catch (err) {
        console.warn('暂存文件到 IndexedDB 失败:', err);
      }

      // 执行完全扫描与计划动作预测
      await refreshPlan();
    },
    onError: (err) => {
      btnConvert.disabled = true;
      resetCategoryFilter();
      console.error(err);
    },
  });

  // 目标平台或高级开关改动时，动态重新生成动作规划
  if (targetSelect) {
    targetSelect.addEventListener('change', () => refreshPlan());
  }
  if (compressionSelect) {
    compressionSelect.addEventListener('change', () => refreshPlan());
  }
  if (filenameTemplateInput) {
    filenameTemplateInput.addEventListener('input', () => refreshPlan());
  }
  if (includeBackupsCheck) {
    includeBackupsCheck.addEventListener('change', () => refreshPlan());
  }
  if (includeCacheCheck) {
    includeCacheCheck.addEventListener('change', () => refreshPlan());
  }
  if (includePrivateCheck) {
    includePrivateCheck.addEventListener('change', () => refreshPlan());
  }

  // 清空工作区按钮
  if (btnClearWorkspace) {
    btnClearWorkspace.addEventListener('click', async () => {
      if (confirm('确定要清空工作区暂存的所有数据包吗？')) {
        await clearAll();
        currentFile = null;
        currentFileId = null;
        btnConvert.disabled = true;
        resetCategoryFilter();
        if (dropHandler?.reset) dropHandler.reset();
        if (workspacePanel) {
          workspacePanel.style.display = 'none';
          workspacePanelOpen = false;
          if (btnToggleWorkspace) btnToggleWorkspace.textContent = '双列表管理 ▾';
        }
        await updateWorkspaceUI();
        view.setProgress(0, '工作区暂存已清空');
      }
    });
  }

  // 7. 开始转换外部 Zip
  btnConvert.addEventListener('click', async () => {
    if (!currentFile) return;
    const target = targetSelect.value;
    const selection = getSelectionState();
    const excludedPaths = getExcludedPaths();
    const includeBackups = includeBackupsCheck ? includeBackupsCheck.checked : true;
    const includeCache = includeCacheCheck ? includeCacheCheck.checked : false;
    const includeAppPrivate = includePrivateCheck ? includePrivateCheck.checked : false;
    const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;

    try {
      btnConvert.disabled = true;
      if (btnRestoreLuker) btnRestoreLuker.disabled = true;
      view.setProgress(5, '正在启动异步 Web Worker 线程处理数据包...');

      const { report, resultBlob } = await runConversionTask({
        source: currentFile,
        target,
        options: {
          selection,
          excludedPaths,
          includeBackups,
          includeCache,
          includeAppPrivate,
          compressionLevel,
        },
        onProgress: (cur, total, name) => {
          const pct = total > 0 ? 5 + Math.round((cur / total) * 90) : 50;
          view.setProgress(pct, `正在转换写入 [${cur}/${total}]: ${name}`);
        },
      });

      lastConvertedBlob = resultBlob;
      view.setProgress(100, `转换成功！共写入 ${report.totals.written} 项，已丢弃/过滤 ${report.totals.dropped + (report.totals.filtered || 0)} 项`);

      // 暂存转换产物到 IndexedDB
      const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
      const outputFilename = resolveFilename(template, {
        sourceName: currentFile.name,
        target,
      });

      try {
        await saveFile({
          name: outputFilename,
          size: resultBlob.size,
          blob: resultBlob,
          layout: target,
          role: 'output',
        });
        await updateWorkspaceUI();
      } catch (e) {
        console.warn('暂存产物失败:', e);
      }

      view.triggerDownload(resultBlob, outputFilename);
      view.renderReport(report);

      if (btnRestoreLuker && host.platform === 'luker') {
        btnRestoreLuker.disabled = false;
      }
    } catch (err) {
      view.setProgress(100, `转换出错: ${err.message}`);
      console.error(err);
    } finally {
      btnConvert.disabled = false;
    }
  });

  // 8. 页面启动时无损恢复工作区状态
  if (isStorageSupported()) {
    try {
      await updateWorkspaceUI();
      const savedState = await loadWorkspaceState();
      if (savedState && savedState.fileId) {
        const fileRecord = await getFile(savedState.fileId);
        if (fileRecord && fileRecord.blob) {
          currentFile = fileRecord.blob;
          currentFile.name = fileRecord.name;
          currentFileId = fileRecord.id;

          // 恢复目标选择与开关
          if (savedState.target && targetSelect) {
            targetSelect.value = savedState.target;
          }
          if (savedState.compressionLevel && compressionSelect) {
            compressionSelect.value = savedState.compressionLevel;
          }
          if (savedState.filenameTemplate && filenameTemplateInput) {
            filenameTemplateInput.value = savedState.filenameTemplate;
          }
          if (typeof savedState.includeBackups === 'boolean' && includeBackupsCheck) {
            includeBackupsCheck.checked = savedState.includeBackups;
          }
          if (typeof savedState.includeCache === 'boolean' && includeCacheCheck) {
            includeCacheCheck.checked = savedState.includeCache;
          }
          if (typeof savedState.includeAppPrivate === 'boolean' && includePrivateCheck) {
            includePrivateCheck.checked = savedState.includeAppPrivate;
          }
          if (savedState.selection) {
            setSelectionState(savedState.selection);
          }
          if (savedState.excludedPaths) {
            setExcludedPaths(savedState.excludedPaths);
          }

          btnConvert.disabled = false;
          if (dropHandler?.setFilename) {
            dropHandler.setFilename(fileRecord.name);
          }

          view.setProgress(0, `已恢复上次工作区：${fileRecord.name} (${formatBytes(fileRecord.size)})`);
          await refreshPlan();
        }
      }
    } catch (err) {
      console.warn('恢复工作区失败:', err);
    }
  }
}

// 启动应用
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
