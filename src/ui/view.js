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

  const discardsAccordion = document.getElementById('discards-accordion');
  const discardsSummary = document.getElementById('discards-summary');
  const discardsLog = document.getElementById('discards-log');

  const warningsAccordion = document.getElementById('warnings-accordion');
  const warningsSummary = document.getElementById('warnings-summary');
  const warningsLog = document.getElementById('warnings-log');

  function setProgress(percent, label = '') {
    progressContainer.classList.add('active');
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    progressBarFill.style.width = `${clamped}%`;
    progressPercent.textContent = `${clamped}%`;
    if (label) statusLabel.textContent = label;
  }

  function hideProgress() {
    progressContainer.classList.remove('active');
  }

  function renderReport(reportJson) {
    reportPanel.classList.add('active');
    const modules = reportJson.modules ?? {};

    countChars.textContent = modules.characters ?? 0;
    countChats.textContent = modules.chats ?? 0;
    countLorebooks.textContent = modules.lorebooks ?? 0;
    countPresets.textContent = modules.presets ?? 0;
    countAssets.textContent = modules.assets ?? 0;
    countExtensions.textContent = modules.extensions ?? 0;
    countSettings.textContent = modules.settings ?? 0;
    countSecrets.textContent = (modules.secrets ?? 0) > 0 ? `${modules.secrets} (安全保留)` : '0';

    // 丢弃项
    const discards = reportJson.discards ?? [];
    if (discards.length > 0) {
      discardsAccordion.style.display = 'block';
      discardsSummary.textContent = `丢弃项清单 (${discards.length} 条 - 派生缓存或不兼容)`;
      discardsLog.textContent = discards.map((d) => `· ${d.path} (${d.reason})`).join('\n');
    } else {
      discardsAccordion.style.display = 'none';
    }

    // 警告项
    const warnings = reportJson.warnings ?? [];
    if (warnings.length > 0) {
      warningsAccordion.style.display = 'block';
      warningsSummary.textContent = `警告与适配提示 (${warnings.length} 条)`;
      warningsLog.textContent = warnings.map((w) => `· ${w}`).join('\n');
    } else {
      warningsAccordion.style.display = 'none';
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
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
