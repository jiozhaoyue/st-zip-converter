/**
 * st-zip-converter 核心控制器 (ESM)
 * 全平台跨酒馆数据包工作站：
 * 1. 宿主酒馆直接细粒度导出 (对齐 ST / Luker 分类) 与直出跨平台目标格式
 * 2. 外部数据包互转、动作规划完全扫描与单项穿透
 * 3. 闭环一键还原/写入宿主 (支持增量合并与全量覆盖)
 * 4. 底部实时抽屉式日志控制台与全屏幕/移动端极致响应式适配
 */

import { runConversionTask, runPlanTask } from './src/core/worker-client.js';
import { logger } from './src/core/logger.js';
import { setupLogConsole } from './src/ui/log-console.js';
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
import { resolveFilename, previewFilename, DEFAULT_FILENAME_TEMPLATE } from './src/core/filename-template.js';
import {
  detectHost,
  fetchHostBackup,
  restoreToHost,
  getHandle,
  registerMenuButton,
  mountSettingsDrawer,
} from './src/ui/host-bridge.js';
import { setupFileDrop } from './src/ui/file-drop.js';
import { createViewController } from './src/ui/view.js';
import { getWorkbenchHtml } from './src/ui/workbench-template.js';
import { splitArchiveEntries } from './src/core/splitter.js';
import { renderSplitDeliveryModal } from './src/ui/split-deliver-modal.js';
import { zipIo } from './src/core/zip-io.js';

function formatTimestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

async function main(appRoot = document.getElementById('app')) {
  const root = appRoot || document.getElementById('app');
  if (!root) return;

  const host = detectHost();
  const view = createViewController();

  // 初始化底部实时日志抽屉
  const logConsole = setupLogConsole(root);
  logger.info(`应用启动，运行模式: ${host.isPlugin ? host.platform.toUpperCase() + ' 扩展插件' : '独立 Web 模式'}`);

  let currentFile = null;
  let currentFileId = null;
  let currentFileHandle = 'default-user';
  let currentHostHandle = 'default-user';
  let lastConvertedBlob = null;
  let isPlanning = false;
  let pendingRestoreFile = null;

  // 实时生成文件名预览
  function updateFilenamePreview() {
    const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;

    const extPreviewEl = document.getElementById('filename-preview');
    if (extPreviewEl) {
      const srcName = currentFile?.name || 'archive.zip';
      const target = targetSelect ? targetSelect.value : 'pt';
      const handle = currentFileHandle || currentHostHandle || 'default-user';
      extPreviewEl.textContent = previewFilename(template, {
        sourceName: srcName,
        target,
        handle,
        part: 'part1',
        category: 'all',
        mode: 'split',
      });
    }

    const hostPreviewEl = document.getElementById('host-filename-preview');
    if (hostPreviewEl) {
      const hostTargetSelect = document.getElementById('host-target-select');
      const selectedTarget = hostTargetSelect ? hostTargetSelect.value : 'native';
      const effectiveTarget = selectedTarget === 'native' ? (host.platform || 'st') : selectedTarget;
      hostPreviewEl.textContent = previewFilename(template, {
        sourceName: `${host.platform || 'st'}-${currentHostHandle}`,
        target: effectiveTarget,
        handle: currentHostHandle,
        part: 'part1',
        category: 'all',
        mode: 'split',
      });
    }
  }

  // DOM 元素引用
  const envBadge = document.getElementById('env-badge');
  const hostUserBadge = document.getElementById('host-user-badge');
  const hostTagPlatform = document.getElementById('host-tag-platform');
  const hostExportCard = document.getElementById('host-export-card');
  const btnRestoreLuker = document.getElementById('btn-restore-luker');
  const targetSelect = document.getElementById('target-select');
  const btnConvert = document.getElementById('btn-convert');

  const workspaceBar = document.getElementById('workspace-bar');
  const workspaceStatusText = document.getElementById('workspace-status-text');
  const btnClearWorkspace = document.getElementById('btn-clear-workspace');
  const workspacePanel = document.getElementById('workspace-panel');

  const includeBackupsCheck = document.getElementById('include-backups-check');
  const includeCacheCheck = document.getElementById('include-cache-check');
  const includePrivateCheck = document.getElementById('include-private-check');
  const incrementalModeCheck = document.getElementById('incremental-mode-check');

  const compressionSelect = document.getElementById('compression-select');
  const filenameTemplateInput = document.getElementById('filename-template-input');
  const placeholderChips = document.getElementById('placeholder-chips');

  // 还原模态弹窗元素
  const restoreModalOverlay = document.getElementById('restore-modal-overlay');
  const restoreModalDesc = document.getElementById('restore-modal-desc');
  const btnCancelRestore = document.getElementById('btn-cancel-restore');
  const btnConfirmRestore = document.getElementById('btn-confirm-restore');

  function getExtensionMode() {
    const checked = document.querySelector('input[name="extension-mode"]:checked');
    return checked ? checked.value : 'manifest';
  }

  function getKeepDevFiles() {
    const chk = document.getElementById('keep-dev-files-check');
    return chk ? chk.checked : false;
  }

  document.querySelectorAll('input[name="extension-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      document.querySelectorAll('.extension-mode-section label').forEach((lbl) => {
        const input = lbl.querySelector('input[name="extension-mode"]');
        if (input) {
          lbl.style.background = input.checked ? 'rgba(137, 180, 250, 0.08)' : 'rgba(255, 255, 255, 0.03)';
          lbl.style.borderColor = input.checked ? 'rgba(137, 180, 250, 0.3)' : 'rgba(255, 255, 255, 0.1)';
        }
      });
      refreshPlan();
    });
  });

  const keepDevFilesCheck = document.getElementById('keep-dev-files-check');
  if (keepDevFilesCheck) {
    keepDevFilesCheck.addEventListener('change', () => refreshPlan());
  }

  // 初始化外部数据包类目过滤器组件
  setupCategoryFilter({
    onSelectionChange: () => {
      refreshPlan();
    },
  });

  // 批量队列转换执行逻辑
  async function runBatchConversion(sourceRecords) {
    if (!sourceRecords || sourceRecords.length === 0) return;
    const target = targetSelect ? targetSelect.value : 'pt';
    const totalCount = sourceRecords.length;
    btnConvert.disabled = true;
    view.setProgress(0, `正在开始批量转换 ${totalCount} 个数据包...`);
    logger.info(`启动批量转换队列，共 ${totalCount} 个包，目标格式: ${target.toUpperCase()}`);

    let completed = 0;
    for (let i = 0; i < totalCount; i++) {
      const srcMeta = sourceRecords[i];
      const full = await getFile(srcMeta.id);
      if (!full?.blob) continue;

      const currentBlob = full.blob;
      currentBlob.name = full.name;

      const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
      const outputFilename = resolveFilename(template, {
        sourceName: currentBlob.name,
        target,
        handle: srcMeta.handle || currentHostHandle || 'default-user',
      });

      const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;

      try {
        const { report, resultBlob } = await runConversionTask({
          source: currentBlob,
          target,
          options: {
            includeBackups: includeBackupsCheck ? includeBackupsCheck.checked : true,
            includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
            includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
            compressionLevel,
          },
          onProgress: (cur, tot, name) => {
            const basePct = Math.round((i / totalCount) * 100);
            const itemPct = tot > 0 ? Math.round((cur / tot) * (100 / totalCount)) : 0;
            view.setProgress(basePct + itemPct, `[${i + 1}/${totalCount}] ${currentBlob.name} -> ${name}`);
          },
        });

        await saveFile({
          name: outputFilename,
          size: resultBlob.size,
          blob: resultBlob,
          layout: target,
          role: 'output',
        });

        completed++;
        logger.success(`[${completed}/${totalCount}] 数据包转换成功: ${outputFilename}`);
      } catch (err) {
        logger.error(`批量转换失败 [${srcMeta.name}]: ${err.message}`);
      }
    }

    view.setProgress(100, `批量队列处理完成：成功 ${completed}/${totalCount} 个包`);
    btnConvert.disabled = false;
    await updateWorkspaceUI();
  }

  // 挂载工作区双列表管理器
  async function refreshArchiveManagerUI() {
    if (!workspacePanel) return;
    await renderArchiveManager({
      containerEl: workspacePanel,
      activeFileId: currentFileId,
      isHostAvailable: host.isPlugin,
      onLoadFile: async (fileRecord) => {
        if (!fileRecord || !fileRecord.blob) return;
        currentFile = fileRecord.blob;
        currentFile.name = fileRecord.name;
        currentFileId = fileRecord.id;
        currentFileHandle = fileRecord.handle || 'default-user';

        btnConvert.disabled = false;
        if (dropHandler?.setFilename) {
          dropHandler.setFilename(fileRecord.name);
        }
        view.setProgress(0, `已载入数据包：${fileRecord.name} (${formatBytes(fileRecord.size)})`);
        logger.info(`载入数据包作为当前处理源: ${fileRecord.name} (用户: ${currentFileHandle})`);
        updateFilenamePreview();
        await refreshPlan();
        refreshArchiveManagerUI();
      },
      onListChanged: async () => {
        await updateWorkspaceUI();
      },
      onBatchConvert: async (sources) => {
        await runBatchConversion(sources);
      },
      onRestoreToHost: (fileRecord) => {
        openRestoreModal(fileRecord);
      },
    });
  }

  // 占位符标签点击智能插入到包名输入框
  if (placeholderChips && filenameTemplateInput) {
    // 阻止鼠标点击时失焦，保留用户光标位置
    placeholderChips.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('.btn-chip');
      if (btn) {
        e.preventDefault();
      }
    });

    placeholderChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-chip');
      if (!btn) return;
      const insertVal = btn.getAttribute('data-insert');
      if (!insertVal) return;

      const input = filenameTemplateInput;
      let val = input.value || '';
      const start = input.selectionStart ?? val.length;
      const end = input.selectionEnd ?? val.length;

      if (start !== end) {
        // 用户主动划选了部分文本，直接替换选区
        input.value = val.slice(0, start) + insertVal + val.slice(end);
        input.setSelectionRange(start + insertVal.length, start + insertVal.length);
      } else if (val.toLowerCase().endsWith('.zip')) {
        // 智能插入在 .zip 扩展名前，并按需自动补全连接符 -
        const base = val.slice(0, -4);
        const sep = (base.length > 0 && !base.endsWith('-') && !base.endsWith('_')) ? '-' : '';
        input.value = `${base}${sep}${insertVal}.zip`;
        const newPos = input.value.length - 4;
        input.setSelectionRange(newPos, newPos);
      } else {
        const sep = (val.length > 0 && !val.endsWith('-') && !val.endsWith('_')) ? '-' : '';
        input.value = `${val}${sep}${insertVal}`;
        input.setSelectionRange(input.value.length, input.value.length);
      }
      input.dispatchEvent(new Event('input'));
      input.focus();
      updateFilenamePreview();
    });
  }

  // 快捷预设模板点击一键应用
  document.querySelectorAll('.btn-tpl-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = btn.getAttribute('data-tpl');
      if (tpl && filenameTemplateInput) {
        filenameTemplateInput.value = tpl;
        filenameTemplateInput.dispatchEvent(new Event('input'));
        updateFilenamePreview();
        refreshPlan();
      }
    });
  });

  // 1. 更新工作区状态栏
  async function updateWorkspaceUI() {
    if (!isStorageSupported()) return;
    try {
      const usage = await getStorageUsage();
      if (workspaceStatusText) {
        workspaceStatusText.textContent = usage.count > 0
          ? `IndexedDB 工作区：已暂存 ${usage.count} 个数据包 (${formatBytes(usage.totalBytes)})`
          : 'IndexedDB 工作区：暂存 0 个数据包';
      }
      await refreshArchiveManagerUI();
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
          extensionMode: getExtensionMode(),
          keepDevFiles: getKeepDevFiles(),
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

  // 4. 插件态界面激活与宿主工作台初始化
  if (host.isPlugin) {
    if (hostExportCard) hostExportCard.style.display = 'block';
    if (hostTagPlatform) {
      hostTagPlatform.textContent = `宿主环境: ${host.platform.toUpperCase()}`;
    }

    // 获取当前用户句柄
    getHandle()
      .then((handle) => {
        currentHostHandle = handle;
        if (hostUserBadge) {
          hostUserBadge.style.display = 'inline-block';
          hostUserBadge.textContent = `用户: ${handle}`;
        }
        logger.info(`已连接宿主用户: ${handle}`);
        updateFilenamePreview();
      })
      .catch((err) => {
        logger.warn('获取当前宿主用户信息提示:', err.message);
      });

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

  // 5. 宿主细粒度导出预设交互
  const hostQuickButtons = document.querySelectorAll('.btn-host-quick');
  const hostCatBoxes = document.querySelectorAll('input[name="host-cat"]');
  const hostLinkCharChatsCheck = document.getElementById('host-link-char-chats');
  const hostIncrementalCheck = document.getElementById('host-incremental-export');

  function updateHostCategorySummary() {
    const summaryEl = document.getElementById('host-category-summary');
    if (!summaryEl) return;
    const checked = document.querySelectorAll('input[name="host-cat"]:checked');
    summaryEl.textContent = `已勾选 ${checked.length}/${hostCatBoxes.length} 项类目`;
  }

  hostQuickButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      const isLinked = hostLinkCharChatsCheck ? hostLinkCharChatsCheck.checked : true;

      hostCatBoxes.forEach((cb) => {
        const val = cb.value;
        if (preset === 'all') {
          cb.checked = true;
        } else if (preset === 'chars') {
          cb.checked = val === 'characters' || val === 'assets' || (isLinked && val === 'chats');
        } else if (preset === 'chats') {
          cb.checked = val === 'chats' || (isLinked && (val === 'characters' || val === 'assets'));
        } else if (preset === 'safe') {
          cb.checked = val !== 'secrets' && val !== 'chats';
        }
      });
      updateHostCategorySummary();
    });
  });

  hostCatBoxes.forEach((cb) => {
    cb.addEventListener('change', updateHostCategorySummary);
  });
  updateHostCategorySummary();

  // 6. 执行宿主导出操作 (支持立即下载与存入工作区)
  async function handleHostExport(targetDestination = 'download') {
    const btnDownload = document.getElementById('btn-host-export-download');
    const btnWorkspace = document.getElementById('btn-host-export-workspace');
    if (btnDownload) btnDownload.disabled = true;
    if (btnWorkspace) btnWorkspace.disabled = true;

    // 汇总勾选的细粒度类目
    const selection = {};
    hostCatBoxes.forEach((cb) => {
      selection[cb.value] = cb.checked;
    });

    const hostTargetSelect = document.getElementById('host-target-select');
    const selectedTarget = hostTargetSelect ? hostTargetSelect.value : 'native';

    try {
      view.setProgress(10, `正在向宿主 ${host.platform.toUpperCase()} 请求数据包...`);
      logger.info(`向宿主请求导出数据包，勾选类目: ${Object.keys(selection).filter((k) => selection[k]).join(', ')}`);

      const rawBackupBlob = await fetchHostBackup(host.platform, selection);
      
      const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
      const effectiveTarget = selectedTarget === 'native' ? host.platform : selectedTarget;
      let finalBlob = rawBackupBlob;
      let targetLayout = host.platform;

      // 无论原生直出还是跨格式直出，统一通过 resolveFilename 依据模板解析文件名并贯通 handle
      let finalFilename = resolveFilename(template, {
        sourceName: `${host.platform}-${currentHostHandle}`,
        target: effectiveTarget,
        handle: currentHostHandle,
      });

      // 检查智能分包与原生资产过滤设置
      const hostSplitSelect = document.getElementById('host-split-select');
      const splitVal = hostSplitSelect ? hostSplitSelect.value : 'none';
      const shouldSplit = splitVal !== 'none';
      const hostPruneBuiltin = document.getElementById('host-prune-builtin');
      const pruneBuiltinAssets = hostPruneBuiltin ? hostPruneBuiltin.checked : true;

      // 如果指定了跨平台直出格式 (非 native) 或启用了原生资产过滤
      if ((selectedTarget !== 'native' && selectedTarget !== host.platform) || pruneBuiltinAssets) {
        targetLayout = selectedTarget === 'native' ? host.platform : selectedTarget;
        view.setProgress(40, `数据已拉取，正在转换处理数据包 (${targetLayout.toUpperCase()})...`);
        logger.info(`进行直出格式与资产过滤处理: ${host.platform.toUpperCase()} -> ${targetLayout.toUpperCase()}`);

        const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;
        const { report, resultBlob } = await runConversionTask({
          source: rawBackupBlob,
          target: targetLayout,
          options: {
            selection,
            includeBackups: includeBackupsCheck ? includeBackupsCheck.checked : true,
            includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
            includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
            compressionLevel,
            extensionMode: getExtensionMode(),
            keepDevFiles: getKeepDevFiles(),
            pruneBuiltinAssets,
          },
          onProgress: (cur, total, name) => {
            const pct = total > 0 ? 40 + Math.round((cur / total) * 50) : 60;
            view.setProgress(pct, `正在直出写入 [${cur}/${total}]: ${name}`);
          },
        });

        finalBlob = resultBlob;
        view.renderReport(report);
      }

      // 执行智能增量分卷 (若开启)
      if (shouldSplit) {
        const thresholdMB = parseInt(splitVal, 10) || 100;
        view.setProgress(92, `正在按 ${thresholdMB} MB 阈值执行智能独立分包...`);
        logger.info(`启动智能分包引擎: 单包阈值 ${thresholdMB} MB`);

        const reader = await zipIo.openReader(finalBlob);
        const entries = [];
        for await (const e of reader.entries()) {
          if (e.isDirectory) { e.skip(); continue; }
          entries.push({ path: e.fileName, data: await e.read(), size: e.uncompressedSize });
        }
        await reader.close();

        const splitResult = await splitArchiveEntries(entries, {
          thresholdMB,
          target: effectiveTarget,
          handle: currentHostHandle,
          filenameTemplate: template,
        });

        for (const p of splitResult.parts) {
          await saveFile({
            name: p.partName,
            size: p.sizeBytes,
            blob: p.blob,
            layout: targetLayout,
            role: targetDestination === 'workspace' ? 'source' : 'output',
          });
        }
        await updateWorkspaceUI();

        if (targetDestination === 'download') {
          renderSplitDeliveryModal(splitResult);
          view.setProgress(100, `宿主数据已成功切分为 ${splitResult.totalParts} 个独立压缩包！`);
          logger.success(`宿主导出分卷完成: 共 ${splitResult.totalParts} 个独立包 (${formatBytes(splitResult.totalBytes)})`);
          return;
        } else {
          view.setProgress(100, `宿主数据 ${splitResult.totalParts} 个分卷已存入本地工作区！`);
          logger.success(`宿主导出分卷已存入工作区完成: 共 ${splitResult.totalParts} 卷`);
          return;
        }
      }

      // 单包模式：暂存到工作区
      await saveFile({
        name: finalFilename,
        size: finalBlob.size,
        blob: finalBlob,
        layout: targetLayout,
        role: targetDestination === 'workspace' ? 'source' : 'output',
      });
      await updateWorkspaceUI();

      if (targetDestination === 'download') {
        view.triggerDownload(finalBlob, finalFilename);
        view.setProgress(100, `宿主数据包导出成功！已开始下载: ${finalFilename}`);
        logger.success(`宿主导出并下载完成: ${finalFilename} (${formatBytes(finalBlob.size)})`);
      } else {
        view.setProgress(100, `宿主数据包已存入本地工作区双列表！`);
        logger.success(`宿主导出并存入工作区完成: ${finalFilename}`);
      }
    } catch (err) {
      view.setProgress(100, `导出失败: ${err.message}`);
      logger.error('宿主导出过程发生错误', err);
    } finally {
      if (btnDownload) btnDownload.disabled = false;
      if (btnWorkspace) btnWorkspace.disabled = false;
    }
  }

  const btnHostDownload = document.getElementById('btn-host-export-download');
  if (btnHostDownload) {
    btnHostDownload.addEventListener('click', () => handleHostExport('download'));
  }
  const btnHostWorkspace = document.getElementById('btn-host-export-workspace');
  if (btnHostWorkspace) {
    btnHostWorkspace.addEventListener('click', () => handleHostExport('workspace'));
  }

  // 7. 还原确认模态弹窗逻辑
  function openRestoreModal(archiveFile) {
    if (!host.isPlugin) {
      alert('还原/写入功能仅在作为 SillyTavern 或 Luker 扩展插件运行且已登录时可用。');
      return;
    }
    pendingRestoreFile = archiveFile;
    if (restoreModalDesc) {
      restoreModalDesc.innerHTML = `即将把数据包 <strong>「${archiveFile.name}」</strong> (${formatBytes(archiveFile.size)}) 恢复写入到当前酒馆宿主 (${host.platform.toUpperCase()})，请选择恢复模式：`;
    }
    if (restoreModalOverlay) {
      restoreModalOverlay.style.display = 'flex';
    }
  }

  if (btnCancelRestore) {
    btnCancelRestore.addEventListener('click', () => {
      pendingRestoreFile = null;
      if (restoreModalOverlay) restoreModalOverlay.style.display = 'none';
    });
  }

  if (btnConfirmRestore) {
    btnConfirmRestore.addEventListener('click', async () => {
      if (!pendingRestoreFile) return;
      const fileToRestore = pendingRestoreFile;
      const modeRadio = document.querySelector('input[name="restore-mode"]:checked');
      const mode = modeRadio ? modeRadio.value : 'merge';

      if (restoreModalOverlay) restoreModalOverlay.style.display = 'none';

      try {
        btnConfirmRestore.disabled = true;
        view.setProgress(15, `正在恢复写入数据包至宿主 (${mode === 'merge' ? '增量合并' : '全量覆盖'})...`);
        logger.info(`向宿主发起数据包恢复请求: ${fileToRestore.name}, 模式: ${mode}`);

        await restoreToHost(fileToRestore.blob, { mode, platform: host.platform });
        view.setProgress(100, `恭喜！数据包已成功恢复写入到当前酒馆用户！`);
        logger.success(`恢复完成！宿主酒馆数据已更新。`);
      } catch (err) {
        view.setProgress(100, `恢复写入失败: ${err.message}`);
        logger.error('恢复写入宿主过程发生错误', err);
        alert(`恢复失败: ${err.message}`);
      } finally {
        btnConfirmRestore.disabled = false;
        pendingRestoreFile = null;
      }
    });
  }

  // Luker 专用旧版快速恢复按钮联动
  if (btnRestoreLuker) {
    btnRestoreLuker.addEventListener('click', () => {
      if (lastConvertedBlob) {
        openRestoreModal({
          name: '最新转换产物.zip',
          size: lastConvertedBlob.size,
          blob: lastConvertedBlob,
        });
      }
    });
  }

  // 8. 外部 Zip 拖拽与转换交互
  const dropHandler = setupFileDrop({
    dropzoneEl: document.getElementById('dropzone'),
    fileInputEl: document.getElementById('file-input'),
    mainTextEl: document.getElementById('drop-main-text'),
    subTextEl: document.getElementById('drop-sub-text'),
    onFilesReady: async (fileItems) => {
      if (!fileItems || fileItems.length === 0) return;
      btnConvert.disabled = false;

      // 批量存入 IndexedDB
      for (const item of fileItems) {
        try {
          const itemHandle = item.detection.handle || 'default-user';
          const id = await saveFile({
            name: item.file.name,
            size: item.file.size,
            blob: item.file,
            layout: item.detection.layout,
            handle: itemHandle,
            role: 'source',
          });
          logger.info(`外部数据包入库成功: ${item.file.name} (识别类型: ${item.detection.layout.toUpperCase()})`);
          if (!currentFile) {
            currentFile = item.file;
            currentFileId = id;
            currentFileHandle = itemHandle;
            if (item.detection.layout === 'st' && targetSelect) targetSelect.value = 'l';
            if (item.detection.layout === 'tt' && targetSelect) targetSelect.value = 'pt';
          }
        } catch (err) {
          logger.warn('暂存文件到 IndexedDB 失败:', err);
        }
      }

      await updateWorkspaceUI();
      updateFilenamePreview();
      if (currentFile) {
        await refreshPlan();
      }
    },
    onError: (err) => {
      btnConvert.disabled = true;
      resetCategoryFilter();
      logger.error('文件读取失败', err);
    },
  });

  // 目标平台或高级开关改动时，动态重新生成动作规划与实时更新预览
  if (targetSelect) {
    targetSelect.addEventListener('change', () => {
      updateFilenamePreview();
      refreshPlan();
    });
  }
  const hostTargetSelect = document.getElementById('host-target-select');
  if (hostTargetSelect) {
    hostTargetSelect.addEventListener('change', () => {
      updateFilenamePreview();
    });
  }
  if (compressionSelect) {
    compressionSelect.addEventListener('change', () => refreshPlan());
  }
  if (filenameTemplateInput) {
    filenameTemplateInput.addEventListener('input', () => {
      updateFilenamePreview();
      refreshPlan();
    });
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
  if (incrementalModeCheck) {
    incrementalModeCheck.addEventListener('change', () => refreshPlan());
  }

  // 清空工作区按钮
  if (btnClearWorkspace) {
    btnClearWorkspace.addEventListener('click', async () => {
      if (confirm('确定要清空工作区暂存的所有数据包吗？')) {
        await clearAll();
        currentFile = null;
        currentFileId = null;
        currentFileHandle = 'default-user';
        btnConvert.disabled = true;
        resetCategoryFilter();
        if (dropHandler?.clear) dropHandler.clear();
        await updateWorkspaceUI();
        updateFilenamePreview();
        view.setProgress(0, '工作区暂存已清空');
        logger.info('工作区所有数据包已清空');
      }
    });
  }

  // 9. 开始转换外部 Zip
  btnConvert.addEventListener('click', async () => {
    if (!currentFile) return;
    const target = targetSelect.value;
    const selection = getSelectionState();
    const excludedPaths = getExcludedPaths();
    const includeBackups = includeBackupsCheck ? includeBackupsCheck.checked : true;
    const includeCache = includeCacheCheck ? includeCacheCheck.checked : false;
    const includeAppPrivate = includePrivateCheck ? includePrivateCheck.checked : false;
    const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;

    // 检查智能分包与原生资产过滤设置
    const splitSelect = document.getElementById('split-select');
    const splitVal = splitSelect ? splitSelect.value : 'none';
    const shouldSplit = splitVal !== 'none';
    const pruneBuiltinCheck = document.getElementById('prune-builtin-check');
    const pruneBuiltinAssets = pruneBuiltinCheck ? pruneBuiltinCheck.checked : true;

    try {
      btnConvert.disabled = true;
      if (btnRestoreLuker) btnRestoreLuker.disabled = true;
      view.setProgress(5, '正在启动异步 Web Worker 线程处理数据包...');
      logger.info(`开始转换外部包: ${currentFile.name} -> ${target.toUpperCase()}`);

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
          extensionMode: getExtensionMode(),
          keepDevFiles: getKeepDevFiles(),
          pruneBuiltinAssets,
        },
        onProgress: (cur, total, name) => {
          const pct = total > 0 ? 5 + Math.round((cur / total) * 90) : 50;
          view.setProgress(pct, `正在转换写入 [${cur}/${total}]: ${name}`);
        },
      });

      lastConvertedBlob = resultBlob;
      const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
      const currentHandle = currentFileHandle || currentHostHandle || 'default-user';

      // 执行智能增量分卷 (若开启)
      if (shouldSplit) {
        const thresholdMB = parseInt(splitVal, 10) || 100;
        view.setProgress(95, `正在按 ${thresholdMB} MB 阈值执行智能独立分包...`);
        logger.info(`启动智能分包引擎: 单包阈值 ${thresholdMB} MB`);

        const reader = await zipIo.openReader(resultBlob);
        const entries = [];
        for await (const e of reader.entries()) {
          if (e.isDirectory) { e.skip(); continue; }
          entries.push({ path: e.fileName, data: await e.read(), size: e.uncompressedSize });
        }
        await reader.close();

        const splitResult = await splitArchiveEntries(entries, {
          thresholdMB,
          target,
          handle: currentHandle,
          filenameTemplate: template,
        });

        for (const p of splitResult.parts) {
          await saveFile({
            name: p.partName,
            size: p.sizeBytes,
            blob: p.blob,
            layout: target,
            role: 'output',
          });
        }
        await updateWorkspaceUI();
        view.renderReport(report);

        renderSplitDeliveryModal(splitResult);
        view.setProgress(100, `外部数据已成功切分为 ${splitResult.totalParts} 个独立压缩包！`);
        logger.success(`外部 Zip 分卷完成: 共 ${splitResult.totalParts} 个独立包 (${formatBytes(splitResult.totalBytes)})`);
        return;
      }

      view.setProgress(100, `转换成功！共写入 ${report.totals.written} 项，已丢弃/过滤 ${report.totals.dropped + (report.totals.filtered || 0)} 项`);
      logger.success(`数据包转换成功！共写入 ${report.totals.written} 个文件`);

      // 暂存转换产物到 IndexedDB
      const outputFilename = resolveFilename(template, {
        sourceName: currentFile.name,
        target,
        handle: currentHandle,
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
      logger.error('数据包转换出错', err);
    } finally {
      btnConvert.disabled = false;
    }
  });

  // 10. 页面启动时无损恢复工作区状态与初始化文件名预览
  updateFilenamePreview();

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
          currentFileHandle = fileRecord.handle || 'default-user';

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
          updateFilenamePreview();

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

let isWorkbenchInitialized = false;

/**
 * 呼出模态数据包工作台 (供宿主插件环境使用)
 */
export function openConverterModal() {
  if (typeof document === 'undefined') return;

  let modalOverlay = document.getElementById('st-converter-modal-overlay');
  if (!modalOverlay) {
    modalOverlay = document.createElement('div');
    modalOverlay.id = 'st-converter-modal-overlay';
    modalOverlay.className = 'st-converter-modal-overlay';

    const appContainer = document.createElement('div');
    appContainer.className = 'app-container';
    appContainer.id = 'app';
    appContainer.innerHTML = getWorkbenchHtml({ isModal: true });

    modalOverlay.appendChild(appContainer);
    document.body.appendChild(modalOverlay);

    const closeBtn = appContainer.querySelector('#btn-close-converter-modal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modalOverlay.style.display = 'none';
      });
    }

    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        modalOverlay.style.display = 'none';
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalOverlay && modalOverlay.style.display !== 'none') {
        modalOverlay.style.display = 'none';
      }
    });

    if (!isWorkbenchInitialized) {
      isWorkbenchInitialized = true;
      main(appContainer);
    }
  } else {
    modalOverlay.style.display = 'flex';
  }
}

/**
 * 自适应启动入口：检测独立 Web 模式 vs 酒馆插件模式
 */
function bootstrap() {
  const host = detectHost();
  const existingApp = document.getElementById('app');

  if (existingApp) {
    // 独立 Web 模式 (直接打开 index.html)
    if (!isWorkbenchInitialized) {
      isWorkbenchInitialized = true;
      main(existingApp);
    }
  } else {
    // 宿主扩展模式 (SillyTavern / Luker)
    // 1. 注入扩展设置抽屉 (#extensions_settings2 / #extensions_settings)
    mountSettingsDrawer(openConverterModal);
    // 2. 注入魔棒快捷菜单 (#extensionsMenu / #options)
    registerMenuButton(openConverterModal);
    logger.info(`st-zip-converter 扩展面板已就绪 (${host.platform.toUpperCase()} 模式)`);
  }
}

// 启动应用
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
}
