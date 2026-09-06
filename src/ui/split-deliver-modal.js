/**
 * 智能分包交付管理面板 (Split Archive Delivery Modal)
 * 呈现切分后的多个独立 Zip 分卷清单，提供一键按序全部下载、单卷下载与云酒馆导入指引。
 */

/**
 * 格式化字节大小
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * 触发单个 Blob 下载
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/**
 * 渲染分包交付管理弹窗
 * @param {object} splitResult splitArchiveEntries 的返回值
 * @param {object} [options]
 * @param {() => Promise<void>} [options.onRestoreHost] 一键依次恢复到当前宿主
 */
export function renderSplitDeliveryModal(splitResult, { onRestoreHost } = {}) {
  if (typeof document === 'undefined') return;

  const MODAL_ID = 'split-deliver-modal';
  const existing = document.getElementById(MODAL_ID);
  if (existing) existing.remove();

  const { parts = [], totalParts = 0, totalFiles = 0, totalBytes = 0 } = splitResult;

  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'st-converter-modal-overlay';
  overlay.style.zIndex = '100000';

  const modalBox = document.createElement('div');
  modalBox.style.cssText = `
    background: #181825; color: #cdd6f4; border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: 12px; width: 100%; max-width: 680px; max-height: 88vh;
    display: flex; flex-direction: column; box-shadow: 0 25px 50px rgba(0,0,0,0.7), 0 0 25px rgba(245, 158, 11, 0.2);
    overflow: hidden; font-family: system-ui, -apple-system, sans-serif;
  `;

  modalBox.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center; background: rgba(245, 158, 11, 0.05);">
      <div>
        <h3 style="margin: 0; font-size: 1.15rem; color: #f59e0b; display: flex; align-items: center; gap: 8px;">
          <span>📦</span> 智能增量分卷导出完成
        </h3>
        <p style="margin: 4px 0 0 0; font-size: 0.83rem; color: #a6adc8;">
          已切分为 <strong>${totalParts}</strong> 个标准独立 Zip 压缩包（共 ${totalFiles} 个文件，${formatBytes(totalBytes)}）。
        </p>
      </div>
      <button id="split-modal-close" style="background: transparent; border: none; color: #a6adc8; font-size: 1.6rem; cursor: pointer; padding: 2px 8px;">&times;</button>
    </div>

    <!-- 导入操作引导提示卡 -->
    <div style="margin: 12px 20px 0 20px; padding: 10px 14px; background: rgba(137, 180, 250, 0.1); border: 1px solid rgba(137, 180, 250, 0.3); border-radius: 6px; font-size: 0.82rem; color: #cdd6f4; line-height: 1.45;">
      💡 <strong>云酒馆免解压增量导入指南：</strong><br>
      每个压缩包均为合法的独立 Zip。在目标云酒馆恢复页面中，直接按 <strong>Part 1 &rarr; Part 2 &rarr; Part 3</strong> 顺序依次上传，云酒馆原生增量合并机制将自动原地融合出完整数据，无需本地二次解压或拼接！
    </div>

    <!-- 分卷列表容器 -->
    <div id="split-parts-list" style="padding: 12px 20px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;">
    </div>

    <!-- 底部控制按钮 -->
    <div style="padding: 14px 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2);">
      <span id="split-download-status" style="font-size: 0.82rem; color: #a6adc8;"></span>
      <div style="display: flex; gap: 10px;">
        <button type="button" id="split-btn-cancel" style="padding: 8px 16px; background: #313244; border: 1px solid #45475a; color: #cdd6f4; border-radius: 6px; cursor: pointer; font-size: 0.85rem;">完成并关闭</button>
        <button type="button" id="split-btn-download-all" class="btn-primary" style="padding: 8px 20px; font-size: 0.88rem; font-weight: bold; cursor: pointer;">
          📥 一键按序下载全部 (${totalParts} 卷)
        </button>
      </div>
    </div>
  `;

  overlay.appendChild(modalBox);
  document.body.appendChild(overlay);

  const listEl = modalBox.querySelector('#split-parts-list');

  parts.forEach((part, idx) => {
    const itemEl = document.createElement('div');
    itemEl.style.cssText = `
      display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px;
      background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px; transition: border-color 0.2s;
    `;

    itemEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
        <span style="font-size: 1.1rem; font-weight: bold; color: #f59e0b; width: 68px;">Part ${part.partIndex}</span>
        <div style="min-width: 0; flex: 1;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 600; color: #cdd6f4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 0.88rem;">${part.partName}</span>
            ${part.isOversized ? '<span style="font-size: 0.72rem; padding: 1px 6px; background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid #ef4444; border-radius: 4px;">⚠️ 超大单文件独占</span>' : ''}
          </div>
          <div style="font-size: 0.78rem; color: #7f849c; margin-top: 3px;">
            <span>大小: <strong style="color: #a6e3a1;">${formatBytes(part.sizeBytes)}</strong></span>
            <span style="margin-left: 12px;">包含: ${part.fileCount} 个文件</span>
          </div>
        </div>
      </div>
      <button type="button" class="btn-secondary split-btn-single" data-idx="${idx}" style="padding: 5px 12px; font-size: 0.8rem; cursor: pointer; white-space: nowrap;">
        📥 下载本卷
      </button>
    `;

    listEl.appendChild(itemEl);
  });

  const closeModal = () => overlay.remove();
  modalBox.querySelector('#split-modal-close').addEventListener('click', closeModal);
  modalBox.querySelector('#split-btn-cancel').addEventListener('click', closeModal);

  // 单卷下载
  modalBox.querySelectorAll('.split-btn-single').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      const part = parts[idx];
      if (part && part.blob) {
        downloadBlob(part.blob, part.partName);
      }
    });
  });

  // 一键按序全部下载 (带 400ms 间隔平滑防浏览器拦截)
  const downloadAllBtn = modalBox.querySelector('#split-btn-download-all');
  const statusEl = modalBox.querySelector('#split-download-status');

  downloadAllBtn.addEventListener('click', async () => {
    downloadAllBtn.disabled = true;
    downloadAllBtn.style.opacity = '0.6';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      statusEl.textContent = `正在下载 Part ${part.partIndex} / ${parts.length}...`;
      downloadBlob(part.blob, part.partName);
      if (i < parts.length - 1) {
        await new Promise((r) => setTimeout(r, 450));
      }
    }

    statusEl.textContent = `🎉 全部 ${parts.length} 个分卷已开始下载！`;
    downloadAllBtn.disabled = false;
    downloadAllBtn.style.opacity = '1';
  });
}
