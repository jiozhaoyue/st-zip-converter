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

  const filteredAccordion = document.getElementById('filtered-accordion');
  const filteredSummary = document.getElementById('filtered-summary');
  const filteredLog = document.getElementById('filtered-log');

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
      countSecrets.textContent = '已脱敏排除';
      countSecrets.style.color = 'var(--accent-luker)';
    } else if (secretsCopied > 0) {
      countSecrets.textContent = `${secretsCopied} (安全保留)`;
      countSecrets.style.color = 'var(--success)';
    } else {
      countSecrets.textContent = '0';
      countSecrets.style.color = 'var(--text-sub)';
    }

    // 丢弃项
    const dropped = reportJson.dropped ?? reportJson.discards ?? [];
    if (dropped.length > 0) {
      discardsAccordion.style.display = 'block';
      discardsSummary.textContent = `丢弃项清单 (${dropped.length} 条 - 派生缓存或不兼容)`;
      discardsLog.textContent = dropped.map((d) => `· ${d.path} (${d.reason})`).join('\n');
    } else {
      discardsAccordion.style.display = 'none';
    }

    // 脱敏排除项
    const filtered = reportJson.filtered ?? [];
    if (filteredAccordion) {
      if (filtered.length > 0) {
        filteredAccordion.style.display = 'block';
        filteredSummary.textContent = `脱敏与排除清单 (${filtered.length} 条 - 按类目主动过滤)`;
        filteredLog.textContent = filtered.map((f) => `· [${f.category}] ${f.path}`).join('\n');
      } else {
        filteredAccordion.style.display = 'none';
      }
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
