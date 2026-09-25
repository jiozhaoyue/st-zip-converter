/**
 * UI 视图渲染与状态更新模块
 */

export function createViewController() {
  const progressContainer = document.getElementById('progress-container');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const statusLabel = document.getElementById('status-label');
  const progressPercent = document.getElementById('progress-percent');

  const reportPanel = document.getElementById('report-panel');
  const countChars = document.getElementById('count-chars');
  const countChats = document.getElementById('count-chats');
  const countLorebooks = document.getElementById('count-lorebooks');
  const countPresets = document.getElementById('count-presets');
  const countAssets = document.getElementById('count-assets');
  const countExtensions = document.getElementById('count-extensions');
  const countSettings = document.getElementById('count-settings');
  const countSecrets = document.getElementById('count-secrets');

  // 报告详情：三份清单合并进单一「报告详情」折叠区，条数摘要写在折叠标题栏
  const foldSummaryReport = document.getElementById('fold-summary-report');
  const discardsLog = document.getElementById('discards-log');
  const filteredLog = document.getElementById('filtered-log');
  const warningsLog = document.getElementById('warnings-log');

  let pendingProgress = null;
  let progressRafId = 0;

  function applyProgress() {
    progressRafId = 0;
    if (pendingProgress === null) return;
    const { percent, label } = pendingProgress;
    pendingProgress = null;
    progressContainer.classList.add('active');
    progressBarFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    if (label) statusLabel.textContent = label;
  }

  /**
   * setProgress 节流版：传输流每秒触发数十次回调，逐次同步写 DOM
   * 会积累 80-107ms 的 longtask（2026-09-07 真机实测），整页随之卡顿。
   * 合并到 rAF 一帧一次写入；label 总是取最新值。
   */
  function setProgress(percent, label = '') {
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    pendingProgress = { percent: clamped, label: label || pendingProgress?.label || '' };
    if (!progressRafId) {
      progressRafId = requestAnimationFrame(applyProgress);
    }
  }

  function hideProgress() {
    progressContainer.classList.remove('active');
  }

  function renderReport(reportJson) {
    // 空状态隐藏：有报告才显示面板（用户裁决 11）
    reportPanel.hidden = false;
    const modules = reportJson.modules ?? {};

    const getCount = (mod) => {
      if (!mod) return 0;
      return typeof mod === 'number' ? mod : (mod.copied ?? 0);
    };

    countChars.textContent = getCount(modules.characters);
    countChats.textContent = getCount(modules.chats);
    countLorebooks.textContent = getCount(modules.lorebooks);
    countPresets.textContent = getCount(modules.presets);
    countAssets.textContent = getCount(modules.assets);
    countExtensions.textContent = getCount(modules.extensions);
    countSettings.textContent = getCount(modules.settings);

    const secretsCopied = getCount(modules.secrets);
    const secretsFiltered = modules.secrets?.filtered ?? 0;
    if (secretsFiltered > 0) {
      countSecrets.textContent = '已脱敏';
      countSecrets.style.color = 'var(--accent-luker)';
    } else if (secretsCopied > 0) {
      countSecrets.textContent = String(secretsCopied);
      countSecrets.style.color = 'var(--success)';
    } else {
      countSecrets.textContent = '0';
      countSecrets.style.color = 'var(--text-sub)';
    }

    // 三份清单写入固定容器；各自的折叠条已合并为单一「报告详情」折叠
    const dropped = reportJson.dropped ?? reportJson.discards ?? [];
    const filtered = reportJson.filtered ?? [];
    const warnings = reportJson.warnings ?? [];

    discardsLog.textContent = dropped.length ? dropped.map((d) => `· ${d.path} (${d.reason})`).join('\n') : '';
    filteredLog.textContent = filtered.length ? filtered.map((f) => `· [${f.category}] ${f.path}`).join('\n') : '';
    warningsLog.textContent = warnings.length ? warnings.map((w) => `· ${w}`).join('\n') : '';

    if (foldSummaryReport) {
      const parts = [];
      if (dropped.length) parts.push(`丢弃 ${dropped.length}`);
      if (filtered.length) parts.push(`排除 ${filtered.length}`);
      if (warnings.length) parts.push(`警告 ${warnings.length}`);
      foldSummaryReport.textContent = parts.join(' · ');
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor); // dom-scope:allow 下载锚点：临时 <a> 必须挂进文档 click() 才会触发下载，紧随其后即 removeChild
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return {
    setProgress,
    hideProgress,
    renderReport,
    triggerDownload,
  };
}
