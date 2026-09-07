/**
 * 酒馆数据包互转工坊 - HTML 模板生成器（两块式）
 * 块一：状态头 + 数据包区（上传暂存 / 待导出）
 * 块二：进度条(sticky) + 报告 + 统一选项 + 执行按钮 + 日志挂载点
 * 支持独立 Web 页面挂载与宿主酒馆 (SillyTavern / Luker) 抽屉/模态复用
 */

export function getWorkbenchHtml({ isModal = false, isDrawer = false } = {}) {
  return `
    ${!isDrawer ? `
    <header class="app-header">
      <div class="title-group">
        <h1><i class="fa-solid fa-file-zipper"></i> 酒馆数据包互转工坊 <span class="header-version">v1.0.0</span></h1>
        <p>SillyTavern · Luker · TauriTavern · PureTavern 互转 · 细粒度导出 · 增量恢复</p>
      </div>
      <div class="header-badges">
        <div class="badge" id="env-badge">检测中...</div>
        <div class="badge badge-user" id="host-user-badge" style="display: none;">用户: 未登录</div>
        ${isModal ? '<button type="button" class="st-converter-modal-close-btn" id="btn-close-converter-modal" title="关闭工作台">&times;</button>' : ''}
      </div>
    </header>
    ` : `
    <!-- 抽屉模式：状态徽标并入块一状态行 -->
    <div class="status-row" id="status-row">
      <span class="badge" id="env-badge">检测中...</span>
      <span class="badge badge-user" id="host-user-badge" style="display: none;">用户: 未登录</span>
      <span class="host-tag-platform" id="host-tag-platform" style="display: none;">宿主环境: 检测中</span>
    </div>
    `}

    <!-- ═══ 块一：状态头 + 数据包区 ═══ -->
    <div class="wb-block wb-block-status">
      <div class="status-row" id="status-row">
        <span class="host-tag-platform" id="host-tag-platform" style="display: none;">宿主环境: 检测中</span>
      </div>
      <div class="quota-bars" id="usage-dashboard"><!-- 两行配额条 (usage-dashboard.js) --></div>

      <div class="zone-card">
        <div class="zone-title"><i class="fa-solid fa-inbox"></i> 上传暂存区</div>
        <div class="dropzone dropzone-inline" id="dropzone">
          <input type="file" id="file-input" accept=".zip" multiple style="display: none;">
          <p class="main-text" id="drop-main-text"><i class="fa-solid fa-cloud-arrow-up"></i> 将酒馆 Zip 数据包拖到此处，或点击选择（可多份）</p>
          <p class="sub-text" id="drop-sub-text">拖入或上传的包自动入库到下方列表</p>
        </div>
        <div id="stash-list"><!-- 源包列表 (stash-list.js) --></div>
        <div id="stash-batch-bar" hidden></div>
      </div>

      <div class="zone-card">
        <div class="zone-title"><i class="fa-solid fa-file-export"></i> 待导出区 <small class="zone-hint">产物统一出口：可拖文件出 / 选位置导出 / 多选批处理</small></div>
        <div id="export-queue-panel"></div>
      </div>
    </div>

    <div class="wb-block wb-block-controls">
      <div class="progress-container" id="progress-container">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progress-bar-fill"></div>
        </div>
        <div class="progress-text">
          <span id="status-label">准备就绪</span>
          <span id="progress-percent">0%</span>
        </div>
        <div class="task-controls" id="task-controls" hidden>
          <button type="button" class="tc-btn" id="tc-pause" title="暂停任务（记录断点，可续传）"><i class="fa-solid fa-pause"></i> 暂停</button>
          <button type="button" class="tc-btn tc-danger" id="tc-abort" title="中止任务（丢弃半成品）"><i class="fa-solid fa-xmark"></i> 中止</button>
          <button type="button" class="tc-btn" id="tc-resume" title="从断点继续" hidden><i class="fa-solid fa-play"></i> 继续</button>
          <button type="button" class="tc-btn tc-danger" id="tc-discard" title="丢弃断点与半成品" hidden><i class="fa-solid fa-trash"></i> 丢弃</button>
        </div>
      </div>

      <div class="report-panel" id="report-panel">
        <div class="module-grid" id="module-grid">
          <div class="module-item"><span class="count" id="count-chars">0</span><span class="label">角色卡</span></div>
          <div class="module-item"><span class="count" id="count-chats">0</span><span class="label">聊天记录</span></div>
          <div class="module-item"><span class="count" id="count-lorebooks">0</span><span class="label">世界书</span></div>
          <div class="module-item"><span class="count" id="count-presets">0</span><span class="label">预设配置</span></div>
          <div class="module-item"><span class="count" id="count-assets">0</span><span class="label">资产与头像</span></div>
          <div class="module-item"><span class="count" id="count-extensions">0</span><span class="label">扩展</span></div>
          <div class="module-item"><span class="count" id="count-settings">0</span><span class="label">系统设置</span></div>
          <div class="module-item"><span class="count" id="count-secrets">0</span><span class="label">密钥(已保护)</span></div>
        </div>

        <details class="log-accordion" id="discards-accordion" style="display: none;">
          <summary id="discards-summary">丢弃项清单 (0 条)</summary>
          <pre id="discards-log"></pre>
        </details>

        <details class="log-accordion" id="filtered-accordion" style="display: none;">
          <summary id="filtered-summary">脱敏与排除清单 (0 条)</summary>
          <pre id="filtered-log"></pre>
        </details>

        <details class="log-accordion" id="warnings-accordion" style="display: none;">
          <summary id="warnings-summary">警告与适配提示 (0 条)</summary>
          <pre id="warnings-log"></pre>
        </details>
      </div>

      <div class="category-panel" id="category-panel" style="display: none;">
        <div class="flex-container justifySpaceBetween alignItemsCenter" style="margin-bottom: 6px;">
          <span class="category-title" style="font-weight: bold; font-size: 0.85rem;"><i class="fa-solid fa-list-check"></i> 类目选择 (对齐 ST / Luker 原生规范)</span>
          <span class="category-sub-summary" id="category-summary-badge" style="font-size: 0.75rem;"></span>
        </div>
        <div class="flex-container" style="gap: 4px; flex-wrap: wrap; margin-bottom: 8px;">
          <button type="button" class="menu_button btn-tool" id="btn-select-all" title="勾选所有有效类目">全选</button>
          <button type="button" class="menu_button btn-tool" id="btn-deselect-all" title="取消所有勾选">全不选</button>
          <button type="button" class="menu_button btn-tool" id="btn-invert-select" title="反转当前可用类目的勾选">反选</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="chars" title="仅勾选角色卡与素材">仅角色卡</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="chats" title="仅勾选聊天记录">仅聊天记录</button>
          <button type="button" class="menu_button btn-tool btn-quick" data-preset="safe" title="脱敏导出：排除密钥与聊天记录">安全脱敏</button>
        </div>
        <div class="link-option-row" style="margin-bottom: 8px;">
          <label class="checkbox_label flex-container" title="开启后，选择角色或聊天时自动联动对方，确保头像与对话上下文完整">
            <input type="checkbox" id="link-char-chats-check" checked>
            <span>角色与聊天智能联动</span>
          </label>
        </div>
        <div class="plan-summary-bar" id="plan-summary-bar" style="display: none; margin-bottom: 8px;">
          <div class="action-badges" id="action-stats-badges"></div>
          <div class="output-estimate" id="output-estimate-text"></div>
        </div>
        <div class="category-grid" id="category-checkboxes"></div>
      </div>

      <div class="unified-options">
        <div class="flex-container flexFlowColumn" style="gap: 8px; margin-bottom: 10px;">
          <div class="flex-container alignItemsCenter" style="gap: 8px;">
            <small style="white-space: nowrap;">目标平台:</small>
            <select id="target-select" class="text_pole flex1">
              <option value="st">SillyTavern (ST 摊平)</option>
              <option value="l">Luker (带清单)</option>
              <option value="tt">TauriTavern (TT 布局)</option>
              <option value="pt" selected>PureTavern (PT 兼容)</option>
            </select>
          </div>
          <div class="flex-container alignItemsCenter" style="gap: 8px;">
            <small style="white-space: nowrap;">Zip 压缩率:</small>
            <select id="compression-select" class="text_pole flex1">
              <option value="5" selected>标准均衡 (Deflate 5)</option>
              <option value="0">极速存储 (Store 0 / 秒级导出)</option>
              <option value="1">快速轻度 (Deflate 1)</option>
              <option value="9">极限压缩 (Deflate 9 / 最小体积)</option>
            </select>
          </div>
          <div class="flex-container alignItemsCenter" style="gap: 8px;">
            <small style="white-space: nowrap;">智能分包:</small>
            <select id="split-select" class="text_pole flex1">
              <option value="none" selected>不分卷 (单包导出)</option>
              <option value="100">100 MB</option>
              <option value="50">50 MB</option>
              <option value="200">200 MB</option>
            </select>
          </div>
          <div class="flex-container flexFlowColumn" style="gap: 4px;">
            <div class="flex-container justifySpaceBetween alignItemsCenter">
              <small>自定义包名:</small>
              <div class="placeholder-chips" id="placeholder-chips">
                <button type="button" class="btn-chip" data-insert="{part}" title="插入分卷序号 (如 part1, part2)">+ {part}</button>
                <button type="button" class="btn-chip" data-insert="{user}" title="插入用户名">+ {user}</button>
                <button type="button" class="btn-chip" data-insert="{date}" title="插入年月日">+ {date}</button>
                <button type="button" class="btn-chip" data-insert="{category}" title="插入类目标识">+ {category}</button>
                <button type="button" class="btn-chip" data-insert="{mode}" title="插入打包模式">+ {mode}</button>
                <button type="button" class="btn-chip" data-insert="{target}" title="插入目标平台代码">+ {target}</button>
              </div>
            </div>
            <input type="text" id="filename-template-input" class="text_pole" placeholder="{target}_{user}_{part}_{date}.zip" value="{target}_{user}_{part}_{date}.zip">
            <div style="display: flex; gap: 8px; align-items: center; margin-top: 3px; font-size: 0.76rem; opacity: 0.85;">
              <span>预设模板:</span>
              <button type="button" class="btn-tpl-preset" data-tpl="{target}_{user}_{part}_{date}.zip">分卷标准</button> |
              <button type="button" class="btn-tpl-preset" data-tpl="{target}_core_{user}_{date}.zip">核心备份</button> |
              <button type="button" class="btn-tpl-preset" data-tpl="{target}_full_{user}_{date}.zip">全量备份</button>
            </div>
            <div class="filename-preview-box" id="filename-preview-box" style="margin-top: 5px; font-size: 0.78rem;">
              <span class="preview-label"><i class="fa-solid fa-tag"></i> 实时生成预览:</span>
              <code class="preview-code" id="filename-preview">pt_default-user_part1.zip</code>
            </div>
          </div>

          <div class="extension-mode-section" style="width: 100%; margin: 8px 0 0 0;">
            <small style="font-weight: bold; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-puzzle-piece"></i> 扩展打包模式:
            </small>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px;">
              <label class="ext-mode-card">
                <input type="radio" name="extension-mode" value="manifest" checked>
                <div>
                  <strong class="ext-mode-title"><i class="fa-solid fa-bolt"></i> 轻量清单模式 (推荐)</strong>
                  <p class="ext-mode-desc">体积缩减 99%，杜绝 408 超时。仅存清单，导入时 depth:1 浅克隆。</p>
                </div>
              </label>
              <label class="ext-mode-card">
                <input type="radio" name="extension-mode" value="full">
                <div>
                  <strong class="ext-mode-title"><i class="fa-solid fa-box-archive"></i> 完整离线包</strong>
                  <p class="ext-mode-desc">打包扩展实体与浅层 Git 结构，已过滤构建冗余，适合无网络离线环境。</p>
                </div>
              </label>
            </div>
            <div style="margin-top: 6px;">
              <label class="checkbox_label flex-container" title="保留构建配置文件（如 webpack.config.js, vite.config.js, tsconfig.json 等）">
                <input type="checkbox" id="keep-dev-files-check">
                <span>保留构建配置 (webpack / vite / tsconfig 等)</span>
              </label>
            </div>
          </div>

          <div class="flex-container flexFlowColumn" style="gap: 6px; margin-top: 8px;">
            <label class="checkbox_label flex-container" title="包含 backups/ 历史快照目录与各角色聊天中的备份文件 (默认不包含)">
              <input type="checkbox" id="include-backups-check">
              <i class="fa-solid fa-clock-rotate-left"></i>
              <span>备份聊天记录与快照 (backups/)</span>
            </label>
            <label class="checkbox_label flex-container" title="包含缩略图与派生缓存 (thumbnails/, _cache/)">
              <input type="checkbox" id="include-cache-check">
              <span>派生缓存</span>
            </label>
            <label class="checkbox_label flex-container" title="包含应用私有设置与引擎状态">
              <input type="checkbox" id="include-private-check">
              <span>私有配置</span>
            </label>
            <label class="checkbox_label flex-container" title="增量合并模式：当包内存在相同文件时仅更新较新文件">
              <input type="checkbox" id="incremental-mode-check">
              <span>增量合并模式</span>
            </label>
            <label class="checkbox_label flex-container" title="差量补丁模式：与外部基准 ZIP 比对，仅导出新增或修改的文件 (宿主拉取与外部转换均生效)">
              <input type="checkbox" id="host-incremental-export">
              <i class="fa-solid fa-code-compare"></i>
              <span>差量补丁模式 (基于基准 ZIP)</span>
            </label>
            <div id="host-base-zip-section" class="base-zip-section" style="display: none;">
              <div class="base-zip-title"><i class="fa-solid fa-file-zipper"></i> 指定基准 ZIP 数据包 (Base Archive)</div>
              <div class="flex-container" style="gap: 6px; flex-wrap: wrap; margin-bottom: 6px;">
                <input type="file" id="host-base-zip-input" accept=".zip" style="display: none;">
                <button type="button" class="menu_button" id="btn-select-base-zip" style="font-size: 0.8rem; padding: 4px 10px;">
                  <i class="fa-solid fa-folder-open"></i> 选择本地基准 ZIP
                </button>
                <select id="host-base-archive-select" class="text_pole" style="font-size: 0.8rem; padding: 3px 8px; max-width: 220px;">
                  <option value="">或从上传暂存区选取...</option>
                </select>
              </div>
              <div id="host-base-zip-status" class="base-zip-status">
                <i class="fa-solid fa-triangle-exclamation"></i> 请先选择基准包，否则无法生成差量补丁
              </div>
            </div>
            <label class="checkbox_label flex-container" title="自动识别并剔除酒馆系统自带的默认背景图、默认主题等静态资源，仅保留个人资产">
              <input type="checkbox" id="prune-builtin-check" checked>
              <span>剔除酒馆原生重复资产</span>
            </label>
          </div>
        </div>

        <div class="action-row">
          <button type="button" class="menu_button menu_button_icon flex1 btn-accent" id="btn-convert" disabled>
            <i class="fa-solid fa-play"></i> <span>开始转换</span>
          </button>
          <button type="button" class="menu_button menu_button_icon flex1 btn-accent" id="btn-host-fetch" style="display: none;">
            <i class="fa-solid fa-server"></i> <span>从宿主拉取</span>
          </button>
          <button type="button" class="menu_button menu_button_icon" id="btn-restore-luker" style="display: none;" disabled>
            <i class="fa-solid fa-file-import"></i> <span>恢复到当前用户</span>
          </button>
        </div>
      </div>

      <!-- 日志控制台挂载点 (setupLogConsole 挂到该节点，位于块二底部) -->
      <div id="log-console-mount"></div>
    </div>

    <div class="restore-modal-overlay" id="restore-modal-overlay" style="display: none;">
      <div class="restore-modal-card">
        <h3 class="modal-title">
          <i class="fa-solid fa-triangle-exclamation"></i> 确认写入/恢复至当前宿主酒馆
        </h3>
        <p class="modal-desc" id="restore-modal-desc">即将把数据包恢复到当前宿主酒馆当前登录用户，请选择恢复模式：</p>
        <div class="restore-mode-group">
          <label class="checkbox_label flex-container">
            <input type="radio" name="restore-mode" value="merge" checked>
            <div class="radio-text">
              <strong>增量合并 (推荐)</strong>
              <span>保留酒馆已有数据，仅新增缺失数据或覆盖同名冲突文件</span>
            </div>
          </label>
          <label class="checkbox_label flex-container">
            <input type="radio" name="restore-mode" value="overwrite">
            <div class="radio-text">
              <strong>全量覆盖</strong>
              <span>重置当前用户数据，完全替换为该数据包内容</span>
            </div>
          </label>
        </div>
        <div class="flex-container" style="justify-content: flex-end; gap: 8px;">
          <button type="button" class="menu_button" id="btn-cancel-restore">取消</button>
          <button type="button" class="menu_button menu_button_icon btn-accent" id="btn-confirm-restore">
            <i class="fa-solid fa-rotate"></i> <span>确认恢复写入</span>
          </button>
        </div>
      </div>
    </div>

    ${!isDrawer ? `
    <footer class="app-footer">
      <p>st-zip-converter · 遵循 SillyTavern 扩展规范 · <a href="https://github.com/jiozhaoyue/st-zip-converter" target="_blank" rel="noopener">GitHub 仓库</a> · <a href="https://github.com/jiozhaoyue/st-zip-converter/fork" target="_blank" rel="noopener">Fork 并部署专属 Pages</a></p>
    </footer>
    ` : ''}
  `;
}
