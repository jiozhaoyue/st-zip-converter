import { logger, LOG_LEVELS } from '../core/logger.js';

/**
 * 实时日志与审计抽屉控制台 (UI)
 * 常驻于主面板底部，支持实时高亮、级别过滤、自动滚屏、一键复制与下载。
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function setupLogConsole(containerElement) {
  if (!containerElement) return null;

  let isExpanded = false;
  let currentFilter = 'ALL';
  let autoScroll = true;

  // 构建 HTML 结构
  const drawer = document.createElement('div');
  drawer.className = 'log-console-drawer';
  drawer.id = 'log-console-drawer';

  drawer.innerHTML = `
    <div class="log-bar-header" id="log-bar-header">
      <div class="log-bar-status">
        <span class="log-indicator-dot" id="log-status-dot"></span>
        <span class="log-latest-text" id="log-latest-text">就绪 · 实时控制台就绪</span>
      </div>
      <div class="log-bar-badges">
        <span class="log-badge badge-info" id="log-badge-info">0 INFO</span>
        <span class="log-badge badge-warn" id="log-badge-warn">0 WARN</span>
        <span class="log-badge badge-error" id="log-badge-error">0 ERR</span>
      </div>
      <div class="log-bar-toggle">
        <button type="button" class="btn-toggle-log" id="btn-toggle-log" title="展开/收起实时日志控制台">展开日志 ▲</button>
      </div>
    </div>
    <div class="log-console-body" id="log-console-body" style="display: none;">
      <div class="log-toolbar">
        <div class="log-filter-group" id="log-filter-group">
          <button type="button" class="btn-log-filter active" data-level="ALL">全部</button>
          <button type="button" class="btn-log-filter" data-level="INFO">信息</button>
          <button type="button" class="btn-log-filter" data-level="WARN">警告</button>
          <button type="button" class="btn-log-filter" data-level="ERROR">错误</button>
        </div>
        <div class="log-action-group">
          <button type="button" class="btn-log-action" id="btn-copy-log" title="复制所有日志到剪贴板"><i class="fa-solid fa-copy"></i> 复制</button>
          <button type="button" class="btn-log-action" id="btn-download-log" title="下载为 .log 文件"><i class="fa-solid fa-download"></i> 导出</button>
          <button type="button" class="btn-log-action" id="btn-clear-log" title="清空日志"><i class="fa-solid fa-trash-can"></i> 清空</button>
        </div>
      </div>
      <div class="log-stream-container" id="log-stream-container">
        <div class="log-empty-state" id="log-empty-state">暂无日志记录</div>
      </div>
    </div>
  `;

  containerElement.appendChild(drawer);

  const headerEl = drawer.querySelector('#log-bar-header');
  const bodyEl = drawer.querySelector('#log-console-body');
  const btnToggle = drawer.querySelector('#btn-toggle-log');
  const statusDot = drawer.querySelector('#log-status-dot');
  const latestText = drawer.querySelector('#log-latest-text');
  const badgeInfo = drawer.querySelector('#log-badge-info');
  const badgeWarn = drawer.querySelector('#log-badge-warn');
  const badgeError = drawer.querySelector('#log-badge-error');
  const streamContainer = drawer.querySelector('#log-stream-container');
  const emptyState = drawer.querySelector('#log-empty-state');
  const filterButtons = drawer.querySelectorAll('.btn-log-filter');
  const btnCopy = drawer.querySelector('#btn-copy-log');
  const btnDownload = drawer.querySelector('#btn-download-log');
  const btnClear = drawer.querySelector('#btn-clear-log');

  function updateBadges() {
    const stats = logger.getStats();
    if (badgeInfo) badgeInfo.textContent = `${stats.info} INFO`;
    if (badgeWarn) {
      badgeWarn.textContent = `${stats.warn} WARN`;
      badgeWarn.style.display = stats.warn > 0 ? 'inline-block' : 'none';
    }
    if (badgeError) {
      badgeError.textContent = `${stats.error} ERR`;
      badgeError.style.display = stats.error > 0 ? 'inline-block' : 'none';
    }

    if (statusDot) {
      if (stats.error > 0) {
        statusDot.className = 'log-indicator-dot dot-error';
      } else if (stats.warn > 0) {
        statusDot.className = 'log-indicator-dot dot-warn';
      } else {
        statusDot.className = 'log-indicator-dot dot-ready';
      }
    }
  }

  function setExpanded(expanded) {
    isExpanded = expanded;
    drawer.classList.toggle('expanded', isExpanded);
    if (bodyEl) bodyEl.style.display = isExpanded ? 'flex' : 'none';
    if (btnToggle) btnToggle.textContent = isExpanded ? '收起日志 ▼' : '展开日志 ▲';

    if (isExpanded) {
      renderLogStream();
      scrollToBottom();
    }
  }

  function scrollToBottom() {
    if (streamContainer && autoScroll) {
      streamContainer.scrollTop = streamContainer.scrollHeight;
    }
  }

  function createLogLineElement(entry) {
    const line = document.createElement('div');
    line.className = `log-line log-${entry.level.toLowerCase()}`;
    line.dataset.level = entry.level;

    let detailHtml = '';
    if (entry.detail) {
      if (typeof entry.detail === 'object') {
        try {
          detailHtml = `<pre class="log-detail">${escapeHtml(JSON.stringify(entry.detail, null, 2))}</pre>`;
        } catch {
          detailHtml = `<span class="log-detail-inline">[Object]</span>`;
        }
      } else {
        detailHtml = `<span class="log-detail-inline">${escapeHtml(String(entry.detail))}</span>`;
      }
    }

    line.innerHTML = `
      <span class="log-time">[${entry.timestamp}]</span>
      <span class="log-tag tag-${entry.level.toLowerCase()}">[${entry.level}]</span>
      <span class="log-msg">${escapeHtml(entry.message)}</span>
      ${detailHtml}
    `;
    return line;
  }

  function renderLogStream() {
    if (!streamContainer) return;
    streamContainer.innerHTML = '';

    const entries = logger.getEntries(currentFilter);
    if (entries.length === 0) {
      if (emptyState) {
        emptyState.style.display = 'block';
        streamContainer.appendChild(emptyState);
      }
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      fragment.appendChild(createLogLineElement(entry));
    }
    streamContainer.appendChild(fragment);
  }

  // 监听容器滚动，用户向上翻阅时暂停自动吸底
  if (streamContainer) {
    streamContainer.addEventListener('scroll', () => {
      const atBottom = streamContainer.scrollHeight - streamContainer.scrollTop - streamContainer.clientHeight < 30;
      autoScroll = atBottom;
    });
  }

  // 头部点击折叠/展开
  if (headerEl) {
    headerEl.addEventListener('click', (e) => {
      // 避免重复触发按钮
      if (e.target === btnToggle || btnToggle?.contains(e.target)) return;
      setExpanded(!isExpanded);
    });
  }
  if (btnToggle) {
    btnToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setExpanded(!isExpanded);
    });
  }

  // 级别过滤
  filterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.level || 'ALL';
      renderLogStream();
      scrollToBottom();
    });
  });

  // 复制日志
  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      const text = logger.exportText();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const origHtml = btnCopy.innerHTML;
        btnCopy.innerHTML = '<i class="fa-solid fa-check"></i> 已复制!';
        setTimeout(() => { btnCopy.innerHTML = origHtml; }, 1800);
      } catch {
        alert('复制失败，请手动在控制台选取');
      }
    });
  }

  // 下载日志
  if (btnDownload) {
    btnDownload.addEventListener('click', () => {
      const text = logger.exportText();
      if (!text) return;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `st-zip-converter-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // 清空日志
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      logger.clear();
      renderLogStream();
      updateBadges();
      if (latestText) latestText.textContent = '就绪 · 日志已清空';
    });
  }

  // 订阅日志单例事件（帧合并批量渲染：高吞吐日志洪泛不再逐条 DOM 追加卡 UI）
  let pendingEntries = [];
  let renderScheduled = false;
  const MAX_LINES_PER_FRAME = 50;

  function flushPendingEntries() {
    renderScheduled = false;
    if (pendingEntries.length === 0) return;
    const batch = pendingEntries;
    pendingEntries = [];

    // 最新动态与徽标取最后一条
    const last = batch[batch.length - 1];
    if (latestText) {
      latestText.textContent = last.message;
      latestText.title = last.message;
    }
    updateBadges();

    if (!isExpanded || !streamContainer) return;

    const matched = batch.filter((e) => currentFilter === 'ALL' || currentFilter === e.level);
    if (matched.length === 0) return;

    if (emptyState && emptyState.parentElement === streamContainer) {
      emptyState.remove();
    }

    const fragment = document.createDocumentFragment();
    const visible = matched.slice(-MAX_LINES_PER_FRAME);
    for (const entry of visible) {
      fragment.appendChild(createLogLineElement(entry));
    }
    // 一帧内超出上限时折叠提示
    const overflow = matched.length - visible.length;
    if (overflow > 0) {
      const note = document.createElement('div');
      note.className = 'log-line log-overflow-note';
      note.textContent = `… 本帧另有 ${overflow} 条日志已折叠（完整内容请导出日志文件）`;
      fragment.appendChild(note);
    }
    streamContainer.appendChild(fragment);
    scrollToBottom();
  }

  logger.subscribe((entry) => {
    if (entry.type === 'CLEAR') {
      pendingEntries = [];
      renderLogStream();
      updateBadges();
      return;
    }

    pendingEntries.push(entry);
    if (!renderScheduled) {
      renderScheduled = true;
      requestAnimationFrame(flushPendingEntries);
    }
  });

  updateBadges();

  return {
    expand: () => setExpanded(true),
    collapse: () => setExpanded(false),
    toggle: () => setExpanded(!isExpanded),
  };
}
