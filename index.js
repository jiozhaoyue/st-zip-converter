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
  selectAll as categorySelectAll,
  resetCategoryFilter,
} from './src/ui/category-filter.js';
import {
  saveFile,
  getFile,
  saveWorkspaceState,
  loadWorkspaceState,
  isStorageSupported,
  listStoredFiles,
} from './src/storage/db.js';
import { generateDeltaArchive } from './src/core/delta.js';
import { TaskManager, TASK_STATES } from './src/core/task-manager.js';
import { renderStashList, filterStashFiles } from './src/ui/stash-list.js';
import { ExportQueue, renderExportQueue } from './src/ui/export-queue.js';
import { initTaskControls } from './src/ui/task-controls.js';
import { createCheckpointAdapter } from './src/storage/authority-store.js';
import { renderUsageDashboard } from './src/ui/usage-dashboard.js';
import { resolveFilename, previewFilename, DEFAULT_FILENAME_TEMPLATE } from './src/core/filename-template.js';
import {
  detectHost,
  verifyHostPlatform,
  fetchHostBackup,
  restoreToHost,
  getHandle,
  registerMenuButton,
  mountNativeBackupButton,
  mountSettingsDrawer,
  setupDrawerToggles,
  hostLayoutCode,
  opfsHandleToFile,
  opfsTmpCleanup,
  supportsOpfs,
  FULL_SELECTION,
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
  setupDrawerToggles(root);

  // 初始化底部实时日志抽屉（块二底部挂载点）
  const logConsole = setupLogConsole(document.getElementById('log-console-mount') || root);
  logger.info(`应用启动，运行模式: ${host.isPlugin ? host.platform.toUpperCase() + ' 扩展插件' : '独立 Web 模式'}`);

  let currentFile = null;
  let currentFileId = null;
  let currentFileHandle = 'default-user';
  let currentHostHandle = 'default-user';
  let lastConvertedBlob = null;
  let isPlanning = false;
  let pendingRestoreFile = null;
  let currentBaseZip = null; // { name: string, blob: Blob, size: number }

  // 实时生成文件名预览（统一目标格式选择器；native 选项经 hostLayoutCode 归一）
  function updateFilenamePreview() {
    const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;

    const extPreviewEl = document.getElementById('filename-preview');
    if (extPreviewEl) {
      const srcName = currentFile?.name || 'archive.zip';
      const rawTarget = targetSelect ? targetSelect.value : 'pt';
      const target = rawTarget === 'native' ? hostLayoutCode(host.platform || 'st') : rawTarget;
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
  }

  // DOM 元素引用
  const envBadge = document.getElementById('env-badge');
  const hostUserBadge = document.getElementById('host-user-badge');
  const btnRestoreLuker = document.getElementById('btn-restore-luker');
  const targetSelect = document.getElementById('target-select');
  const btnConvert = document.getElementById('btn-convert');

  const usageDashboardEl = document.getElementById('usage-dashboard');
  const exportQueuePanel = document.getElementById('export-queue-panel');

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

  // 统一文件树确认栏按钮（宿主拉取阶段2）
  const btnHostTreeConfirm = document.getElementById('btn-host-tree-confirm');
  const btnHostTreeCancel = document.getElementById('btn-host-tree-cancel');
  const btnHostTreeSelectAll = document.getElementById('btn-host-tree-selectall');
  if (btnHostTreeConfirm) {
    btnHostTreeConfirm.addEventListener('click', () => resolveHostTreeConfirm(true));
  }
  if (btnHostTreeCancel) {
    btnHostTreeCancel.addEventListener('click', () => resolveHostTreeConfirm(false));
  }
  if (btnHostTreeSelectAll) {
    btnHostTreeSelectAll.addEventListener('click', () => categorySelectAll());
  }

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
            includeBackups: includeBackupsCheck ? includeBackupsCheck.checked : false,
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

        exportQueue.enqueue({
          name: outputFilename,
          blob: resultBlob,
          targetLayout: target,
          origin: 'converted',
          ephemeral: true,
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

  // 上传暂存区源包列表（含选中批操作）
  async function refreshArchiveManagerUI() {
    const stashListEl = document.getElementById('stash-list');
    const stashBatchBar = document.getElementById('stash-batch-bar');
    if (!stashListEl) return;
    await renderStashList({
      containerEl: stashListEl,
      batchBarEl: stashBatchBar,
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
        await refreshArchiveManagerUI();
      },
      onListChanged: async () => {
        await updateWorkspaceUI();
      },
      onRestoreToHost: (fileRecord) => {
        openRestoreModal(fileRecord);
      },
    });
  }

  // 用量看板（配额条 + 来源统计 + 包体积列表）
  async function refreshUsageDashboard() {
    if (!usageDashboardEl) return;
    await renderUsageDashboard({ containerEl: usageDashboardEl });
  }

  // 待导出区（所有产物统一出口）
  const exportQueue = new ExportQueue();

  // 长任务管理器（宿主拉取/转换/写回共用）+ 进度条旁任务控制条
  // 断点持久化：Authority 后端可用时走服务端 KV（跨会话/多端），否则回退默认内存 adapter
  const authorityCheckpointAdapter = await createCheckpointAdapter();
  const taskManager = new TaskManager(authorityCheckpointAdapter || undefined);
  const taskControls = initTaskControls({
    taskManager,
    onPause: (id) => {
      // 拉取执行体在 reader 循环内感知 signal.aborted 后自行 checkpoint+cancel；
      // 此处仅记录暂停请求已发起。
      logger.info(`暂停请求已发送: ${id}`);
    },
    onResume: (id, checkpoint) => {
      if (id.startsWith('fetch-')) handleHostExport({ resumeCheckpoint: checkpoint, resumeTaskId: id });
    },
    onAbort: (id) => {
      logger.warn(`任务已中止: ${id}`);
      if (opfsCleanupId === id) {
        opfsTmpCleanup(opfsCleanupName);
        opfsCleanupId = null;
        opfsCleanupName = null;
      }
    },
    onDiscard: (id) => {
      logger.warn(`断点与半成品已丢弃: ${id}`);
      if (opfsCleanupId === id) {
        opfsTmpCleanup(opfsCleanupName);
        opfsCleanupId = null;
        opfsCleanupName = null;
      }
    },
  });
  // 当前 OPFS 半成品归属（中止/丢弃时清理）
  let opfsCleanupId = null;
  let opfsCleanupName = null;
  function refreshExportQueueUI() {
    if (!exportQueuePanel) return;
    renderExportQueue({
      containerEl: exportQueuePanel,
      queue: exportQueue,
      isHostAvailable: host.isPlugin,
      onRestoreToHost: (item) => {
        openRestoreModal({ name: item.name, blob: item.blob, size: item.blob.size });
      },
      onWorkspaceChanged: async () => {
        await updateWorkspaceUI();
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

  // 1. 刷新数据包区（暂存列表/配额条/待导出区）
  async function updateWorkspaceUI() {
    if (!isStorageSupported()) return;
    try {
      await refreshArchiveManagerUI();
      await refreshUsageDashboard();
      refreshExportQueueUI();
    } catch (err) {
      console.warn('刷新工作区 UI 失败:', err);
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
      const includeBackups = includeBackupsCheck ? includeBackupsCheck.checked : false;
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

  // 3. 宿主环境识别与 Badge 标识（单枚合并徽标：运行形态 + 宿主 + 服务端版本）
  const HOST_BADGE_STYLES = {
    st: { text: 'SillyTavern 插件', color: 'var(--accent-st)' },
    luker: { text: 'Luker 插件', color: 'var(--accent-luker)' },
    standalone: { text: '独立 Web 模式', color: '' },
  };
  const applyHostBadge = (platform, version = null) => {
    if (!envBadge) return;
    const style = HOST_BADGE_STYLES[platform] || HOST_BADGE_STYLES.standalone;
    envBadge.textContent = version && platform !== 'standalone'
      ? `${style.text} · v${version}`
      : style.text;
    if (style.color) {
      envBadge.style.color = style.color;
      envBadge.style.borderColor = style.color;
    } else {
      envBadge.style.color = '';
      envBadge.style.borderColor = '';
    }
  };
  applyHostBadge(host.platform);

  // 4. 插件态界面激活与宿主工作台初始化
  const applyPluginUi = (platform) => {
    if (!host.isPlugin) return;
    const btnHostFetch = document.getElementById('btn-host-fetch');
    if (btnHostFetch) btnHostFetch.style.display = 'inline-flex';

    // ST 宿主端点不支持 selection：在类目面板头部注入"插件内过滤"提示
    const categoryPanel = document.getElementById('category-panel');
    let hint = document.getElementById('host-selection-mode-hint');
    if (platform === 'st' && categoryPanel && !hint) {
      hint = document.createElement('small');
      hint.id = 'host-selection-mode-hint';
      hint.className = 'zone-hint';
      hint.style.display = 'block';
      hint.textContent = 'ST 宿主端点仅支持全量导出：勾选的类目将在导出后由插件内过滤生效';
      categoryPanel.insertBefore(hint, categoryPanel.firstChild);
    } else if (hint) {
      hint.style.display = platform === 'st' ? 'block' : 'none';
    }

    if (platform === 'luker' && btnRestoreLuker) {
      btnRestoreLuker.style.display = 'inline-block';
    }
    if (targetSelect) {
      // 插件模式注入"宿主原生格式"选项并默认选中（native → 执行时经 hostLayoutCode 归一）
      let nativeOpt = targetSelect.querySelector('option[value="native"]');
      if (!nativeOpt) {
        nativeOpt = document.createElement('option');
        nativeOpt.value = 'native';
        nativeOpt.textContent = `宿主原生格式 (${hostLayoutCode(platform).toUpperCase()})`;
        targetSelect.insertBefore(nativeOpt, targetSelect.firstChild);
      }
      targetSelect.value = 'native';
    }
    registerMenuButton(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // 原生"用户数据备份"UI 旁也注入入口，与扩展设置抽屉共存；
    // 「一键拉取」复用完整 handleHostExport 流程（TaskManager/文件树确认/待导出区）
    mountNativeBackupButton(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, {
      onQuickFetch: () => handleHostExport(),
    });
  };
  applyPluginUi(host.platform);

  // 服务端 /version 二次校验：不一致时以服务端为准并刷新 UI
  if (host.isPlugin) {
    verifyHostPlatform(host.platform)
      .then(({ platform: verifiedPlatform, version }) => {
        if (verifiedPlatform !== host.platform && verifiedPlatform !== 'standalone') {
          host.platform = verifiedPlatform;
          applyPluginUi(verifiedPlatform);
          logger.info(`宿主环境已按服务端校验结果刷新: ${verifiedPlatform.toUpperCase()}`);
        }
        if (verifiedPlatform !== 'standalone') {
          applyHostBadge(verifiedPlatform, version || null);
        }
      })
      .catch((err) => console.warn('宿主服务端校验失败:', err));
  }

  if (host.isPlugin) {
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
  }

  // 5. 差量补丁基准包交互（统一开关组内，宿主拉取与外部转换共用）
  const hostIncrementalCheck = document.getElementById('host-incremental-export');
  const hostBaseZipSection = document.getElementById('host-base-zip-section');
  const hostBaseZipInput = document.getElementById('host-base-zip-input');
  const btnSelectBaseZip = document.getElementById('btn-select-base-zip');
  const hostBaseArchiveSelect = document.getElementById('host-base-archive-select');
  const hostBaseZipStatus = document.getElementById('host-base-zip-status');

  async function refreshBaseArchiveOptions() {
    if (!hostBaseArchiveSelect) return;
    try {
      const storedFiles = filterStashFiles(await listStoredFiles());
      const currentVal = hostBaseArchiveSelect.value;
      hostBaseArchiveSelect.innerHTML = '<option value="">或从上传暂存区选取...</option>';
      if (storedFiles && storedFiles.length > 0) {
        storedFiles.forEach((f) => {
          const opt = document.createElement('option');
          opt.value = f.id;
          opt.textContent = `${f.name} (${formatBytes(f.size)})`;
          hostBaseArchiveSelect.appendChild(opt);
        });
      }
      if (currentVal) hostBaseArchiveSelect.value = currentVal;
    } catch {
      // 忽略
    }
  }

  function updateBaseZipStatusUI() {
    if (!hostBaseZipStatus) return;
    if (currentBaseZip) {
      hostBaseZipStatus.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #10b981;"></i> 已就绪基准包: <b>${currentBaseZip.name}</b> (${formatBytes(currentBaseZip.size)})`;
      hostBaseZipStatus.style.color = 'var(--SmartThemeQuoteColor, #93c5fd)';
    } else {
      hostBaseZipStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 请先选择已有基准包，否则无法生成增量差量补丁';
      hostBaseZipStatus.style.color = '#f87171';
    }
  }

  if (hostIncrementalCheck) {
    hostIncrementalCheck.addEventListener('change', () => {
      const isInc = hostIncrementalCheck.checked;
      if (hostBaseZipSection) {
        hostBaseZipSection.style.display = isInc ? 'block' : 'none';
      }
      if (isInc) {
        refreshBaseArchiveOptions();
        updateBaseZipStatusUI();
      }
    });
  }

  if (btnSelectBaseZip && hostBaseZipInput) {
    btnSelectBaseZip.addEventListener('click', () => {
      hostBaseZipInput.click();
    });

    hostBaseZipInput.addEventListener('change', () => {
      const file = hostBaseZipInput.files?.[0];
      if (file) {
        currentBaseZip = {
          name: file.name,
          blob: file,
          size: file.size,
        };
        updateBaseZipStatusUI();
        logger.info(`已设定外部基准 ZIP: ${file.name} (${formatBytes(file.size)})`);
      }
    });
  }

  if (hostBaseArchiveSelect) {
    hostBaseArchiveSelect.addEventListener('change', async () => {
      const id = hostBaseArchiveSelect.value;
      if (!id) return;
      try {
        const fileRecord = await getFile(id);
        if (fileRecord && fileRecord.blob) {
          currentBaseZip = {
            name: fileRecord.name,
            blob: fileRecord.blob,
            size: fileRecord.size || fileRecord.blob.size,
          };
          updateBaseZipStatusUI();
          logger.info(`已从暂存区载入基准 ZIP: ${fileRecord.name}`);
        }
      } catch (err) {
        logger.error('载入基准包失败:', err);
      }
    });
  }

  // 6. 执行宿主拉取操作（统一选项，产物一律进待导出区）

  // 统一文件树确认栏（宿主拉取阶段2：渲染树 → 用户勾选 → 确认/取消）
  let hostTreeConfirmResolve = null;

  function waitHostTreeConfirm(taskId) {
    return new Promise((resolve) => {
      hostTreeConfirmResolve = resolve;
      const bar = document.getElementById('host-tree-confirm-bar');
      if (!bar) {
        resolve(true); // 无确认栏（测试环境/模板漂移）：维持现状行为直接继续
        return;
      }
      bar.hidden = false;
      bar.dataset.taskId = taskId;
      view.setProgress(38, `请在统一文件树勾选需要的文件/类目，确认后继续`);
    });
  }

  function resolveHostTreeConfirm(confirmed) {
    const bar = document.getElementById('host-tree-confirm-bar');
    if (bar) bar.hidden = true;
    if (hostTreeConfirmResolve) {
      const r = hostTreeConfirmResolve;
      hostTreeConfirmResolve = null;
      r(confirmed);
    }
  }

  async function handleHostExport({ resumeCheckpoint = null, resumeTaskId = null } = {}) {
    const btnHostFetch = document.getElementById('btn-host-fetch');

    // 检查差量补丁模式是否已指定基准包
    const isIncremental = hostIncrementalCheck ? hostIncrementalCheck.checked : false;
    if (isIncremental && !currentBaseZip) {
      logger.error('差量补丁模式开启，必须先选择一个已有基准 ZIP！');
      alert('【差量补丁提示】\n差量补丁模式必须选择一个已有 ZIP 作为基准包！\n请在面板中点击“选择本地基准 ZIP”或从上传暂存区选取基准包。');
      if (hostBaseZipSection) hostBaseZipSection.style.display = 'block';
      updateBaseZipStatusUI();
      return;
    }

    if (btnHostFetch) btnHostFetch.disabled = true;

    // 统一类目勾选（与外部转换路径共用同一份 category-filter 状态）
    const selection = getSelectionState();

    const selectedTarget = targetSelect ? targetSelect.value : 'native';

    // 断点续传：携带清单重跑（Range 尽力而为，见 fetchHostBackup 内部决策）
    const taskId = resumeTaskId || `fetch-${Date.now()}`;
    let opfsName = null; // OPFS 半成品名（catch 清理需引用，须在 try 外声明避免 TDZ ReferenceError）
    const { signal, onCheckpoint } = taskManager.start(taskId, '宿主拉取', {
      resumable: true,
      totalBytes: resumeCheckpoint?.totalBytes || 0,
    });
    taskControls.showRunning(taskId, { totalBytes: resumeCheckpoint?.totalBytes || 0 });
    if (resumeCheckpoint) {
      logger.info(`续传任务 ${taskId}: 断点 ${formatBytes(resumeCheckpoint.receivedBytes || 0)}`);
    }

    try {
      view.setProgress(10, `正在向宿主 ${host.platform.toUpperCase()} 请求数据包...`);
      logger.info(`向宿主请求导出数据包，勾选类目: ${Object.keys(selection).filter((k) => selection[k]).join(', ')}`);

      // ST 宿主的 /api/users/backup 端点不支持 selection（全量 glob 导出）：
      // 必须请求全量包，类目筛选由下方 needsTransform 分支在插件内过滤生效；
      // Luker 宿主端点原生支持 selection，直接透传。
      const hostSupportsSelection = host.platform === 'luker';
      const endpointSelection = hostSupportsSelection
        ? selection
        : { ...FULL_SELECTION };
      if (!hostSupportsSelection) {
        logger.info('ST 宿主端点仅支持全量导出，类目筛选将在导出后由插件内过滤执行');
      }

      // Luker 服务端 selection.settings 会隐含打包 backups/ 目录（历史快照，
      // src/users.js getUserBackupTargets）：勾了 settings 的用户每次都在拉
      // 全部历史备份，GB 级 backups 是"慢"的主因——发请求前给出明确警示。
      const hostIncludeBackups = includeBackupsCheck ? includeBackupsCheck.checked : false;
      if (hostSupportsSelection && endpointSelection.settings && !hostIncludeBackups) {
        logger.warn('提示: 勾选「系统设置」时 Luker 服务端会隐含打包 backups/ 历史快照目录（可能数 GB）。'
          + '若拉取缓慢，请清理酒馆内历史备份快照，或在下方勾选项中取消「系统设置」。');
      }

      const rawBackup = await fetchHostBackup(host.platform, endpointSelection, {
        taskId,
        signal,
        resumeCheckpoint,
        onPhase: async (phase, received, total, opfsName, currentBps) => {
          // 实测速度直显（bytes/s → MB/s），非估算
          const speedText = currentBps ? ` ${((currentBps / 1048576)).toFixed(1)} MB/s` : '';
          const receivedText = `已接收 ${(received / 1048576).toFixed(1)}${total > 0 ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB`;
          if (phase === 'host-generating') {
            view.setProgress(12, `[1/3 宿主打包中] 正在请求 /api/users/backup · 服务端正在读取磁盘并压缩打包 (deflate) · 用户: ${currentHostHandle} · 此阶段耗时取决于数据量与服务端 CPU`);
          } else if (phase === 'transferring') {
            if (total > 0) {
              const pct = 15 + Math.round((received / total) * 20);
              view.setProgress(pct, `[2/3 传输中] 正在接收宿主打包的 ZIP 流 · ${receivedText}${speedText}`);
            } else {
              view.setProgress(18, `[2/3 传输中] 正在接收宿主打包的 ZIP 流 (无 Content-Length) · ${receivedText}${speedText}`);
            }
            // 断点清单跟踪（TaskManager 节流持久化；中止/暂停时由 fetch 循环 force 落盘）
            if (opfsName) {
              await onCheckpoint({
                receivedBytes: received,
                totalBytes: total,
                opfsName,
              }, { bytes: received });
            }
          }
        },
      });

      // 统一源形态：OPFS 句柄 → File（zip.js 原生消费 File，零内存拷贝）
      const rawBackupIsOpfs = rawBackup && rawBackup.kind === 'opfs';
      opfsName = rawBackupIsOpfs ? rawBackup.name : null;
      const rawBackupBlob = rawBackupIsOpfs
        ? await opfsHandleToFile(rawBackup.handle)
        : rawBackup;

      // 记录 OPFS 半成品归属（中止/丢弃时清理）
      if (rawBackupIsOpfs) {
        opfsCleanupId = taskId;
        opfsCleanupName = opfsName;
      }

      // ===== 统一文件树：先扫描后拉取（阶段2 等待用户确认勾选）=====
      // 端点不支持文件级导出（ST/Luker 同），拉取本身全量落盘；
      // 过滤在本地 convert() 以 excludedPaths 完成，零额外网络成本。
      view.setProgress(38, `数据包已落盘，正在扫描文件树 (只读中央目录)...`);
      let hostPlan = null;
      try {
        const effectiveTargetPreview = selectedTarget === 'native'
          ? hostLayoutCode(host.platform)
          : selectedTarget;
        hostPlan = await runPlanTask({
          source: rawBackupBlob,
          target: effectiveTargetPreview,
          options: {
            selection: getSelectionState(),
            excludedPaths: getExcludedPaths(),
            includeBackups: includeBackupsCheck ? includeBackupsCheck.checked : false,
            includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
            includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
            extensionMode: getExtensionMode(),
            keepDevFiles: getKeepDevFiles(),
            pruneBuiltinAssets: document.getElementById('prune-builtin-check')?.checked ?? true,
          },
        });
      } catch (scanErr) {
        logger.warn(`统一文件树扫描失败 (${scanErr.message})，降级为按类目勾选继续`);
      }

      if (hostPlan) {
        renderCategoryStats(hostPlan);
        logger.info(`统一文件树就绪: ${hostPlan.totalSourceFiles} 个文件，可展开类目明细逐文件勾选，确认后继续转换`);
      }

      const confirmed = await waitHostTreeConfirm(taskId);
      if (!confirmed) {
        // 用户中止/丢弃：清理半成品与清单
        await taskManager.abort(taskId);
        taskControls.hide();
        if (opfsName) await opfsTmpCleanup(opfsName);
        resetCategoryFilter();
        view.setProgress(100, `宿主拉取已取消`);
        logger.info('宿主拉取在文件树确认阶段被取消，半成品已清理');
        return;
      }

      // 确认后的勾选状态即为最终过滤依据（树派生 selection/excludedPaths 已由 category-filter 维护）
      const confirmedSelection = getSelectionState();
      const confirmedExcludedPaths = getExcludedPaths();

      const template = filenameTemplateInput?.value || DEFAULT_FILENAME_TEMPLATE;
      const effectiveTarget = selectedTarget === 'native'
        ? hostLayoutCode(host.platform)
        : selectedTarget;
      let finalBlob = rawBackupBlob;
      let targetLayout = effectiveTarget;

      // 无论原生直出还是跨格式直出，统一通过 resolveFilename 依据模板解析文件名并贯通 handle
      let finalFilename = resolveFilename(template, {
        sourceName: `${host.platform}-${currentHostHandle}`,
        target: effectiveTarget,
        handle: currentHostHandle,
      });

      // 检查智能分包与原生资产过滤设置（统一控件）
      const splitSelect = document.getElementById('split-select');
      const splitVal = splitSelect ? splitSelect.value : 'none';
      const shouldSplit = splitVal !== 'none';
      const pruneBuiltinCheck = document.getElementById('prune-builtin-check');
      const pruneBuiltinAssets = pruneBuiltinCheck ? pruneBuiltinCheck.checked : true;

      // 如果指定了跨平台直出格式 (非 native) 或启用了原生资产过滤 或 不包含备份聊天与快照
      // ST 宿主下 selection 由插件内过滤生效，因此只要勾选不全量就必须走转换过滤；
      // 统一文件树确认后的 excludedPaths（逐文件勾选差异）也强制走转换过滤
      const hasPartialSelection = hostSupportsSelection
        ? false
        : Object.keys(FULL_SELECTION).some((k) => !selection[k]);
      const hasFileExclusions = confirmedExcludedPaths.size > 0;
      const needsTransform = (selectedTarget !== 'native' && selectedTarget !== effectiveTarget)
        || pruneBuiltinAssets
        || !hostIncludeBackups
        || hasPartialSelection
        || hasFileExclusions;

      if (needsTransform) {
        targetLayout = selectedTarget === 'native'
          ? hostLayoutCode(host.platform)
          : selectedTarget;
        view.setProgress(40, `数据已拉取，正在转换处理数据包 (${targetLayout.toUpperCase()})...`);
        logger.info(`进行直出格式与资产过滤处理: ${host.platform.toUpperCase()} -> ${targetLayout.toUpperCase()} (包含备份聊天: ${hostIncludeBackups}, 逐文件排除: ${confirmedExcludedPaths.size})`);

        const compressionLevel = compressionSelect ? parseInt(compressionSelect.value, 10) : 5;
        const { report, resultBlob } = await runConversionTask({
          source: rawBackupBlob,
          target: targetLayout,
          options: {
            selection: confirmedSelection,
            excludedPaths: confirmedExcludedPaths,
            includeBackups: hostIncludeBackups,
            includeCache: includeCacheCheck ? includeCacheCheck.checked : false,
            includeAppPrivate: includePrivateCheck ? includePrivateCheck.checked : false,
            compressionLevel,
            extensionMode: getExtensionMode(),
            keepDevFiles: getKeepDevFiles(),
            pruneBuiltinAssets,
            signal,
          },
          onProgress: (cur, total, name) => {
            const pct = total > 0 ? 40 + Math.round((cur / total) * 50) : 60;
            view.setProgress(pct, `正在直出写入 [${cur}/${total}]: ${name}`);
          },
        });

        finalBlob = resultBlob;
        view.renderReport(report);
      } else if (hasFileExclusions || confirmedExcludedPaths.size > 0) {
        // 不转换时排除集也应同步到当前过滤器（保持树状态与产物一致）
        setExcludedPaths(confirmedExcludedPaths);
      }

      // 执行外部基准增量导出比对 (生成仅包含新增与修改项的纯增量补丁包)
      if (isIncremental && currentBaseZip) {
        view.setProgress(88, `正在与外部基准包比对差异并生成增量补丁 (基准: ${currentBaseZip.name})...`);
        logger.info(`启动外部基准增量比对: [${currentBaseZip.name}] vs 最新宿主数据`);

        const deltaResult = await generateDeltaArchive(currentBaseZip.blob, finalBlob, {
          baseName: currentBaseZip.name,
          level: compressionSelect ? parseInt(compressionSelect.value, 10) : 5,
        });

        finalBlob = deltaResult.deltaBlob;
        finalFilename = finalFilename.replace(/\.zip$/i, '') + '_delta_patch.zip';
        logger.success(`纯增量补丁包构建成功: 新增 ${deltaResult.stats.addedCount} 项, 修改 ${deltaResult.stats.modifiedCount} 项, 保持不变 ${deltaResult.stats.unchangedCount} 项 (补丁体积: ${formatBytes(finalBlob.size)})`);
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

        // 分卷统一进待导出区（来源=分卷），供统一处置
        for (const p of splitResult.parts) {
          exportQueue.enqueue({
            name: p.partName,
            blob: p.blob,
            targetLayout: targetLayout,
            origin: 'split-part',
            ephemeral: true,
          });
        }
        refreshExportQueueUI();
        view.setProgress(100, `宿主数据已切分为 ${splitResult.totalParts} 个分卷，已进入待导出区统一处置！`);
        logger.success(`宿主导出分卷完成: 共 ${splitResult.totalParts} 个独立包 (${formatBytes(splitResult.totalBytes)})，可在待导出区批量下载或存入工作区`);
        if (opfsName) await opfsTmpCleanup(opfsName);
        return;
      }

      // 单包模式：统一进待导出区（增量补丁产物标记 delta 来源）
      const isDeltaPatch = /_delta_patch\.zip$/i.test(finalFilename);
      exportQueue.enqueue({
        name: finalFilename,
        blob: finalBlob,
        targetLayout: targetLayout,
        origin: isDeltaPatch ? 'delta' : 'host-export',
        ephemeral: true,
      });
      refreshExportQueueUI();

      view.setProgress(100, `宿主数据包已进入待导出区！`);
      logger.success(`宿主拉取完成: ${finalFilename} (${formatBytes(finalBlob.size)}) —— 可在待导出区下载、选位置导出、存入工作区或写回宿主`);
      await taskManager.complete(taskId);
      taskControls.hide();
      if (opfsName) await opfsTmpCleanup(opfsName);
    } catch (err) {
      if (err?.name === 'AbortError') {
        // 暂停（signal.aborted + paused 状态）与中止在 UI 层表现一致；中止路径 taskControls 已复位
        const rec = taskManager.get(taskId);
        if (rec && rec.state === TASK_STATES.PAUSED) {
          const total = rec.checkpoint?.totalBytes || rec.totalBytes || 0;
          const received = rec.receivedBytes || rec.checkpoint?.receivedBytes || 0;
          const pct = total > 0 ? Math.round((received / total) * 100) : 0;
          taskControls.showPaused(taskId, { percent: pct, receivedBytes: received, totalBytes: total });
          taskControls.setPausedCheckpoint(taskId, rec.checkpoint);
          view.setProgress(pct, `任务已暂停，可从断点继续或丢弃`);
          logger.info(`任务已暂停于 ${pct}% (${formatBytes(received)})`);
        } else if (rec && rec.state === TASK_STATES.ABORTED) {
          taskControls.hide();
          view.setProgress(100, `任务已中止`);
          if (typeof opfsName === 'string' && opfsName) await opfsTmpCleanup(opfsName);
        }
      } else {
        await taskManager.fail(taskId, Boolean(opfsName));
        taskControls.hide();
        if (typeof opfsName === 'string' && opfsName) await opfsTmpCleanup(opfsName);
        view.setProgress(100, `导出失败: ${err.message}`);
        logger.error('宿主拉取过程发生错误', err);
      }
    } finally {
      if (btnHostFetch) btnHostFetch.disabled = false;
    }
  }

  const btnHostFetch = document.getElementById('btn-host-fetch');
  if (btnHostFetch) {
    btnHostFetch.addEventListener('click', () => handleHostExport());
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

  // 9. 开始转换外部 Zip
  btnConvert.addEventListener('click', async () => {
    if (!currentFile) return;
    const target = targetSelect.value;
    const selection = getSelectionState();
    const excludedPaths = getExcludedPaths();
    const includeBackups = includeBackupsCheck ? includeBackupsCheck.checked : false;
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

        // 分卷统一进待导出区（来源=分卷）
        for (const p of splitResult.parts) {
          exportQueue.enqueue({
            name: p.partName,
            blob: p.blob,
            targetLayout: target,
            origin: 'split-part',
            ephemeral: true,
          });
        }
        refreshExportQueueUI();
        view.renderReport(report);

        view.setProgress(100, `外部数据已切分为 ${splitResult.totalParts} 个分卷，进入待导出区统一处置！`);
        logger.success(`外部 Zip 分卷完成: 共 ${splitResult.totalParts} 个独立包 (${formatBytes(splitResult.totalBytes)})，可在待导出区批量下载或存入工作区`);
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

      // 统一出口：产物进入待导出区，由用户在待导出区执行 下载/存工作区/写回宿主
      exportQueue.enqueue({
        name: outputFilename,
        blob: resultBlob,
        targetLayout: target,
        origin: 'converted',
        ephemeral: true,
      });
      refreshExportQueueUI();
      view.renderReport(report);

      view.setProgress(100, `转换完成！产物已进入待导出区: ${outputFilename}`);
      logger.success(`转换成功: ${outputFilename} (${formatBytes(resultBlob.size)}) —— 可在待导出区下载、选位置导出、存入工作区或写回宿主`);

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
    // 仅在扩展设置抽屉中展开工作台，遵循“只在插件页面做，不在魔法棒做”
    mountSettingsDrawer((drawerApp) => {
      if (!isWorkbenchInitialized && drawerApp) {
        isWorkbenchInitialized = true;
        main(drawerApp);
      }
    });
    logger.info(`st-zip-converter 扩展设置抽屉已就绪 (${host.platform.toUpperCase()} 模式)`);
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
