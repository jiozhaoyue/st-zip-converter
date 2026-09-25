/**
 * 酒馆数据包互转工坊 - HTML 模板生成器（分区式 · 单一模板源）
 *
 * 三个入口共用本函数（L1-MR-10 单向化 · 2026-09-25）：
 *   · 独立 Web   ：index.html 空骨架 → bootstrap() 注入 getWorkbenchHtml({ isStandalone: true })
 *   · 插件抽屉态 ：mountSettingsDrawer() → getWorkbenchHtml({ isDrawer: true })
 *   · 模态态     ：openConverterModal() → getWorkbenchHtml({ isModal: true })
 *
 * 分区与披露级别（用户 2026-09-25 逐项裁决，见任务 09-25-ui-slim-native/prd.md）：
 *   A 状态 / B 源包 / C 产物 / E 动作 / F 输出目标 / G 内容范围 —— 首屏常驻
 *   H 垃圾清理 / I 扩展打包 / J 增量与差量 / K 包名 —— 宿主原生 inline-drawer 折叠
 *
 * 文案约定：不出现解释性静态文案（描述段 / 括号补充 / 小字提示 / 教学性 tooltip）。
 *   保留：状态与错误反馈、placeholder、图标自身悬停名、状态读数摘要。
 */

/** 徽标组（抽屉态渲染在块一状态行，其余模式渲染在页头；两处只渲染一份，防重复 id） */
const BADGES_HTML = `
      <span class="badge" id="env-badge">检测中...</span>
      <span class="badge badge-user" id="host-user-badge" style="display: none;">用户: 未登录</span>
`;

/**
 * 生成工作台 HTML
 * @param {{isModal?: boolean, isDrawer?: boolean, isStandalone?: boolean}} [opts]
 * @returns {string}
 */
export function getWorkbenchHtml({ isModal = false, isDrawer = false, isStandalone = false } = {}) {
  // 独立态与模态态共用页头/页脚；抽屉态嵌在宿主设置侧栏内，不出页头
  const chrome = !isDrawer;
  void isStandalone;

  return `
    ${chrome ? `
    <header class="app-header">
      <div class="title-group">
        <h1><i class="fa-solid fa-file-zipper"></i> 酒馆数据包互转工坊</h1>
      </div>
      <div class="header-badges">
        ${BADGES_HTML}
        ${isModal ? '<button type="button" class="st-converter-modal-close-btn" id="btn-close-converter-modal" title="关闭工作台">&times;</button>' : ''}
      </div>
    </header>
    ` : ''}

    <!-- ═══ 块一：状态 · 源包 · 产物 ═══ -->
    <div class="wb-block wb-block-status">
      ${isDrawer ? `
      <div class="status-row" id="status-row">
        ${BADGES_HTML}
        <button type="button" class="menu_button menu_button_icon wb-storage-btn" id="btn-storage-inspector" hidden>
          <i class="fa-solid fa-hard-drive"></i><span>存储</span>
        </button>
      </div>
      ` : ''}
      <div class="quota-bars" id="usage-dashboard"><!-- 配额条 (usage-dashboard.js) --></div>

      <div class="zone-card">
        <div class="zone-title"><i class="fa-solid fa-inbox"></i> 上传暂存区</div>
        <div class="dropzone dropzone-inline" id="dropzone">
          <input type="file" id="file-input" accept=".zip" multiple style="display: none;">
          <p class="main-text" id="drop-main-text"><i class="fa-solid fa-cloud-arrow-up"></i> 将酒馆 Zip 数据包拖到此处或点击选择</p>
          <p class="sub-text" id="drop-sub-text"></p>
        </div>
        <div id="stash-list"><!-- 源包列表 (stash-list.js) --></div>
        <div id="stash-batch-bar" hidden></div>
      </div>

      <div class="zone-card">
        <div class="zone-title"><i class="fa-solid fa-file-export"></i> 待导出区</div>
        <div id="export-queue-panel"></div>
      </div>
    </div>

    <!-- ═══ 块二：配置 · 执行 · 反馈 ═══ -->
    <div class="wb-block wb-block-controls">

      <!-- [G] 内容范围（常驻） -->
      <div class="category-panel" id="category-panel" style="display: none;">
        <div class="flex-container justifySpaceBetween alignItemsCenter" style="margin-bottom: 6px;">
          <span class="category-title"><i class="fa-solid fa-list-check"></i> 内容范围</span>
          <span class="category-sub-summary" id="category-summary-badge"></span>
        </div>
        <div class="flex-container" style="gap: 4px; flex-wrap: wrap; margin-bottom: 8px;">
          <button type="button" class="menu_button btn-tool" id="btn-select-all">全选</button>
          <button type="button" class="menu_button btn-tool" id="btn-deselect-all">全不选</button>
          <button type="button" class="menu_button btn-tool" id="btn-invert-select">反选</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="chars">仅角色卡</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="chats">仅聊天记录</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="safe">安全脱敏</button>
        </div>
        <div class="plan-summary-bar" id="plan-summary-bar" style="display: none; margin-bottom: 8px;">
          <div class="action-badges" id="action-stats-badges"></div>
          <div class="output-estimate" id="output-estimate-text"></div>
        </div>
        <div class="category-grid" id="category-checkboxes"></div>
        <div class="host-tree-confirm-bar" id="host-tree-confirm-bar" hidden>
          <span class="htc-hint"><i class="fa-solid fa-list-check"></i> 统一文件树已就绪</span>
          <div class="htc-actions">
            <button type="button" class="menu_button btn-tool" id="btn-host-tree-selectall">全选</button>
            <button type="button" class="menu_button menu_button_icon btn-accent" id="btn-host-tree-confirm">
              <i class="fa-solid fa-check"></i> <span>继续转换</span>
            </button>
            <button type="button" class="menu_button" id="btn-host-tree-cancel">
              <i class="fa-solid fa-ban"></i> <span>取消</span>
            </button>
          </div>
        </div>
      </div>

      <!-- [F] 输出目标（常驻三联） -->
      <div class="output-row">
        <label class="output-field">
          <small>目标平台</small>
          <select id="target-select" class="text_pole">
            <option value="st">SillyTavern</option>
            <option value="l">Luker</option>
            <option value="tt">TauriTavern</option>
            <option value="pt" selected>PureTavern</option>
          </select>
        </label>
        <label class="output-field">
          <small>压缩级别</small>
          <select id="compression-select" class="text_pole">
            <option value="5" selected>5</option>
            <option value="0">0</option>
            <option value="1">1</option>
            <option value="9">9</option>
          </select>
        </label>
        <label class="output-field">
          <small>分卷 MB</small>
          <input type="number" id="split-input" class="text_pole" min="1" step="1" inputmode="numeric" placeholder="不分卷">
        </label>
      </div>

      <!-- [H] 垃圾清理（默认清理，折叠） -->
      <div class="inline-drawer wb-fold" id="fold-cleanup">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-broom"></i> 垃圾清理</b>
          <span class="wb-fold-summary" id="fold-summary-cleanup"></span>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
          <div class="wb-checks">
            <label class="checkbox_label flex-container">
              <input type="checkbox" id="include-backups-check">
              <span>打包 backups/ 快照</span>
            </label>
            <label class="checkbox_label flex-container">
              <input type="checkbox" id="include-cache-check">
              <span>打包派生缓存</span>
            </label>
            <label class="checkbox_label flex-container">
              <input type="checkbox" id="include-private-check">
              <span>打包私有配置</span>
            </label>
            <label class="checkbox_label flex-container">
              <input type="checkbox" id="prune-builtin-check" checked>
              <span>剔除酒馆原生重复资产</span>
            </label>
          </div>
        </div>
      </div>

      <!-- [I] 扩展打包（折叠） -->
      <div class="inline-drawer wb-fold" id="fold-extension">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-puzzle-piece"></i> 扩展打包</b>
          <span class="wb-fold-summary" id="fold-summary-extension"></span>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
          <div class="ext-mode-row">
            <label class="ext-mode-opt">
              <input type="radio" name="extension-mode" value="manifest" checked>
              <span>轻量清单</span>
            </label>
            <label class="ext-mode-opt">
              <input type="radio" name="extension-mode" value="full">
              <span>完整离线包</span>
            </label>
          </div>
          <div class="wb-checks">
            <label class="checkbox_label flex-container">
              <input type="checkbox" id="keep-dev-files-check">
              <span>保留构建配置</span>
            </label>
          </div>
          <div class="wb-actions">
            <button type="button" id="btn-export-ext-manifest" class="menu_button menu_button_icon">
              <i class="fa-solid fa-file-export"></i> <span>导出扩展清单</span>
            </button>
          </div>
        </div>
      </div>

      <!-- [J] 增量与差量（折叠） -->
      <div class="inline-drawer wb-fold" id="fold-incremental">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-code-compare"></i> 增量与差量</b>
          <span class="wb-fold-summary" id="fold-summary-incremental"></span>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
          <div class="wb-checks">
            <label class="checkbox_label flex-container">
              <input type="checkbox" id="incremental-mode-check">
              <span>增量合并</span>
            </label>
            <label class="checkbox_label flex-container">
              <input type="checkbox" id="host-incremental-export">
              <span>差量补丁</span>
            </label>
          </div>
          <div id="host-base-zip-section" class="base-zip-section" style="display: none;">
            <div class="flex-container" style="gap: 6px; flex-wrap: wrap; margin-bottom: 6px;">
              <input type="file" id="host-base-zip-input" accept=".zip" style="display: none;">
              <button type="button" class="menu_button" id="btn-select-base-zip">
                <i class="fa-solid fa-folder-open"></i> 选择基准 ZIP
              </button>
              <select id="host-base-archive-select" class="text_pole">
                <option value="">从暂存区选取</option>
              </select>
            </div>
            <div id="host-base-zip-status" class="base-zip-status"></div>
          </div>
        </div>
      </div>

      <!-- [K] 包名（折叠） -->
      <div class="inline-drawer wb-fold" id="fold-filename">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-tag"></i> 包名</b>
          <span class="wb-fold-summary" id="fold-summary-filename"></span>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
          <input type="text" id="filename-template-input" class="text_pole" placeholder="{target}_{user}_{part}_{date}.zip" value="{target}_{user}_{part}_{date}.zip">
          <div class="filename-preview-box" id="filename-preview-box">
            <code class="preview-code" id="filename-preview"></code>
          </div>
        </div>
      </div>

      <!-- [E] 动作（常驻） -->
      <div class="action-row">
        <button type="button" class="menu_button menu_button_icon flex1" id="btn-host-fetch" style="display: none;">
          <i class="fa-solid fa-server"></i> <span>从宿主拉取</span>
        </button>
        <button type="button" class="menu_button menu_button_icon flex1 btn-accent" id="btn-convert" disabled>
          <i class="fa-solid fa-play"></i> <span>开始转换</span>
        </button>
        <button type="button" class="menu_button menu_button_icon flex1" id="btn-restore-luker" style="display: none;" disabled>
          <i class="fa-solid fa-file-import"></i> <span>恢复到当前用户</span>
        </button>
      </div>

      <!-- [D] 执行反馈（常驻） -->
      <div class="progress-container" id="progress-container">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progress-bar-fill"></div>
        </div>
        <div class="progress-text">
          <span id="status-label">准备就绪</span>
          <span id="progress-percent">0%</span>
        </div>
        <div class="task-controls" id="task-controls" hidden>
          <button type="button" class="tc-btn" id="tc-pause" title="暂停"><i class="fa-solid fa-pause"></i> 暂停</button>
          <button type="button" class="tc-btn tc-danger" id="tc-abort" title="中止"><i class="fa-solid fa-xmark"></i> 中止</button>
          <button type="button" class="tc-btn" id="tc-resume" title="继续" hidden><i class="fa-solid fa-play"></i> 继续</button>
          <button type="button" class="tc-btn tc-danger" id="tc-discard" title="丢弃" hidden><i class="fa-solid fa-trash"></i> 丢弃</button>
        </div>
      </div>

      <div class="report-panel" id="report-panel" hidden>
        <div class="module-grid" id="module-grid">
          <div class="module-item"><span class="count" id="count-chars">0</span><span class="label">角色卡</span></div>
          <div class="module-item"><span class="count" id="count-chats">0</span><span class="label">聊天记录</span></div>
          <div class="module-item"><span class="count" id="count-lorebooks">0</span><span class="label">世界书</span></div>
          <div class="module-item"><span class="count" id="count-presets">0</span><span class="label">预设配置</span></div>
          <div class="module-item"><span class="count" id="count-assets">0</span><span class="label">资产与头像</span></div>
          <div class="module-item"><span class="count" id="count-extensions">0</span><span class="label">扩展</span></div>
          <div class="module-item"><span class="count" id="count-settings">0</span><span class="label">系统设置</span></div>
          <div class="module-item"><span class="count" id="count-secrets">0</span><span class="label">密钥</span></div>
        </div>

        <div class="inline-drawer wb-fold" id="fold-report-details">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-list"></i> 报告详情</b>
            <span class="wb-fold-summary" id="fold-summary-report"></span>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content" style="display: none;">
            <pre id="discards-log"></pre>
            <pre id="filtered-log"></pre>
            <pre id="warnings-log"></pre>
          </div>
        </div>
      </div>

      <!-- 日志控制台挂载点 -->
      <div id="log-console-mount"></div>
    </div>

    <div class="restore-modal-overlay" id="restore-modal-overlay" style="display: none;">
      <div class="restore-modal-card">
        <h3 class="modal-title"><i class="fa-solid fa-triangle-exclamation"></i> 恢复至当前宿主</h3>
        <p class="modal-desc" id="restore-modal-desc"></p>
        <div class="restore-mode-group">
          <label class="checkbox_label flex-container">
            <input type="radio" name="restore-mode" value="merge" checked>
            <div class="radio-text"><strong>增量合并</strong></div>
          </label>
          <label class="checkbox_label flex-container">
            <input type="radio" name="restore-mode" value="overwrite">
            <div class="radio-text"><strong>全量覆盖</strong></div>
          </label>
        </div>
        <div class="flex-container" style="justify-content: flex-end; gap: 8px;">
          <button type="button" class="menu_button" id="btn-cancel-restore">取消</button>
          <button type="button" class="menu_button menu_button_icon btn-accent" id="btn-confirm-restore">
            <i class="fa-solid fa-rotate"></i> <span>确认恢复</span>
          </button>
        </div>
      </div>
    </div>

    ${chrome ? `
    <footer class="app-footer">
      <p><a href="https://github.com/jiozhaoyue/st-zip-converter" target="_blank" rel="noopener">GitHub</a></p>
    </footer>
    ` : ''}
  `;
}
