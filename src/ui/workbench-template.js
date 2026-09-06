/**
 * 酒馆数据包互转工坊 - 完整 HTML 模板生成器
 * 支持独立 Web 页面挂载与宿主酒馆 (SillyTavern / Luker) 模态弹窗复用
 */

export function getWorkbenchHtml({ isModal = false } = {}) {
  return `
    <!-- Header -->
    <header class="app-header">
      <div class="title-group">
        <h1>🍺 酒馆数据包互转工坊 <span class="header-version">v1.0.0</span></h1>
        <p>SillyTavern · Luker · TauriTavern · PureTavern 互转 · 细粒度导出 · 增量恢复</p>
      </div>
      <div class="header-badges">
        <div class="badge" id="env-badge">检测中...</div>
        <div class="badge badge-user" id="host-user-badge" style="display: none;">用户: 未登录</div>
        ${isModal ? '<button type="button" class="st-converter-modal-close-btn" id="btn-close-converter-modal" title="关闭工作台">&times;</button>' : ''}
      </div>
    </header>

    <!-- Workspace Bar -->
    <div class="workspace-bar" id="workspace-bar">
      <div class="workspace-info">
        <span class="workspace-icon">💾</span>
        <span id="workspace-status-text">工作区就绪</span>
      </div>
      <div class="workspace-actions">
        <button type="button" class="btn-workspace-clear" id="btn-clear-workspace" title="清除暂存的数据包并重置工作区">清空暂存</button>
      </div>
    </div>

    <!-- Workspace Dual List Panel (Permanent) -->
    <div class="workspace-panel card" id="workspace-panel">
      <!-- 由 archive-manager.js 动态挂载已上传与已转换双列表 -->
    </div>

    <!-- Section 1: 宿主酒馆数据导出工作台 (在酒馆/Luker插件环境中完整激活) -->
    <section class="card" id="host-export-card" style="display: none;">
      <div class="card-header-row">
        <h2 class="card-title">🏛️ 宿主酒馆数据导出工作台</h2>
        <div class="host-meta-status" id="host-meta-status">
          <span class="host-tag-platform" id="host-tag-platform">宿主环境: 检测中</span>
        </div>
      </div>

      <!-- 细粒度导出类目勾选区 -->
      <div class="host-category-box">
        <div class="category-header">
          <div class="category-title-group">
            <span class="category-title">📋 细粒度导出类目勾选</span>
            <span class="category-sub-summary" id="host-category-summary">已勾选全部标准数据</span>
          </div>
          <div class="category-actions">
            <div class="btn-group-quick">
              <button type="button" class="btn-tool btn-host-quick" data-preset="all">全选</button>
              <button type="button" class="btn-tool btn-host-quick" data-preset="chars">仅角色卡</button>
              <button type="button" class="btn-tool btn-host-quick" data-preset="chats">仅聊天记录</button>
              <button type="button" class="btn-tool btn-host-quick" data-preset="safe">安全脱敏</button>
            </div>
          </div>
        </div>

        <div class="host-category-grid" id="host-category-grid">
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="characters" checked>
            <span>🎭 角色卡</span>
          </label>
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="chats" checked>
            <span>💬 聊天记录</span>
          </label>
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="lorebooks" checked>
            <span>📖 世界书</span>
          </label>
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="presets" checked>
            <span>⚙️ 预设配置</span>
          </label>
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="assets" checked>
            <span>🖼️ 资产与背景</span>
          </label>
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="settings" checked>
            <span>🛠️ 系统设置</span>
          </label>
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="secrets" checked>
            <span>🔑 敏感密钥</span>
          </label>
          <label class="category-chip-label">
            <input type="checkbox" name="host-cat" value="extensions" checked>
            <span>🧩 扩展插件</span>
          </label>
        </div>

        <div class="host-options-row">
          <label class="checkbox-group" title="开启后，勾选角色或聊天时自动联动对方，确保头像与对话记录完整">
            <input type="checkbox" id="host-link-char-chats" checked>
            <span>角色与聊天智能联动</span>
          </label>
          <label class="checkbox-group" title="增量导出模式：按变更状态或指定条件仅导出更新数据">
            <input type="checkbox" id="host-incremental-export">
            <span>增量导出模式</span>
          </label>
          <label class="checkbox-group" title="自动过滤酒馆原生默认背景图、默认主题等静态资源，仅打包用户个人导入的增量资产">
            <input type="checkbox" id="host-prune-builtin" checked>
            <span>剔除酒馆原生重复资产</span>
          </label>
        </div>
      </div>

      <!-- 宿主直出目标与控制 -->
      <div class="host-export-controls">
        <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: center;">
          <div class="target-select-group">
            <label for="host-target-select">一步直出格式:</label>
            <select id="host-target-select" class="select-input">
              <option value="native" selected>当前宿主原生格式</option>
              <option value="st">SillyTavern (ST 摊平)</option>
              <option value="l">Luker (带清单)</option>
              <option value="tt">TauriTavern (TT 布局)</option>
              <option value="pt">PureTavern (PT 兼容)</option>
            </select>
          </div>

          <div class="split-select-group" style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem;">
            <label for="host-split-select" style="color: var(--text-muted); font-weight: 500;">智能分包限制:</label>
            <select id="host-split-select" class="select-input">
              <option value="none">不分卷 (单包完整导出)</option>
              <option value="100" selected>100 MB (云酒馆推荐 / 独立分卷)</option>
              <option value="50">50 MB (高限制容器环境)</option>
              <option value="200">200 MB (宽松上限)</option>
            </select>
          </div>
        </div>

        <div class="host-filename-preview-row" id="host-filename-preview-row">
          <span class="preview-label">📦 导出文件名预览:</span>
          <code class="preview-code" id="host-filename-preview">st-default-user-part1-2026-09-06.zip</code>
        </div>

        <div class="host-action-buttons">
          <button type="button" class="btn-primary" id="btn-host-export-download">🚀 导出并立即下载</button>
          <button type="button" class="btn-secondary" id="btn-host-export-workspace">📥 导出并存入工作区</button>
        </div>
      </div>
    </section>

    <!-- Section 2: 外部数据包互转区 (全环境通用) -->
    <section class="card" id="external-convert-card">
      <h2 class="card-title">📦 转换任意酒馆 Zip 数据包</h2>
      <div class="dropzone" id="dropzone">
        <input type="file" id="file-input" accept=".zip" multiple style="display: none;">
        <p class="main-text" id="drop-main-text">将酒馆 Zip 数据包拖放到此处，或点击浏览选择</p>
        <p class="sub-text" id="drop-sub-text">支持多选或同时拖入多个 Zip 备份包批量入库</p>
      </div>

      <!-- Section 2.5: 数据包内容与细粒度类目选择 (对齐 ST / Luker) -->
      <div class="category-panel" id="category-panel" style="display: none;">
        <div class="category-header">
          <div class="category-title-group">
            <span class="category-title">📋 类目选择 (对齐 ST / Luker 原生规范)</span>
            <span class="category-sub-summary" id="category-summary-badge"></span>
          </div>
          <div class="category-actions">
            <div class="btn-group-main">
              <button type="button" class="btn-tool" id="btn-select-all" title="勾选所有有效类目">全选</button>
              <button type="button" class="btn-tool" id="btn-deselect-all" title="取消所有勾选">全不选</button>
              <button type="button" class="btn-tool" id="btn-invert-select" title="反转当前可用类目的勾选">反选</button>
            </div>
            <div class="btn-group-quick">
              <button type="button" class="btn-tool btn-quick" data-preset="chars" title="仅勾选角色卡与素材">仅角色卡</button>
              <button type="button" class="btn-tool btn-quick" data-preset="chats" title="仅勾选聊天记录">仅聊天记录</button>
              <button type="button" class="btn-tool btn-quick" data-preset="safe" title="脱敏导出：排除密钥与聊天记录">安全脱敏</button>
            </div>
          </div>
        </div>

        <div class="link-option-row">
          <label class="checkbox-group" title="开启后，选择角色或聊天时自动联动对方，确保头像与对话上下文完整">
            <input type="checkbox" id="link-char-chats-check" checked>
            <span>角色与聊天智能联动</span>
          </label>
        </div>

        <!-- 完全扫描动作预测条 -->
        <div class="plan-summary-bar" id="plan-summary-bar" style="display: none;">
          <div class="action-badges" id="action-stats-badges"></div>
          <div class="output-estimate" id="output-estimate-text"></div>
        </div>

        <div class="category-grid" id="category-checkboxes">
          <!-- 动态注入全部细粒度 Checkbox 与体积计数 -->
        </div>
      </div>

      <div class="controls-row">
        <div class="target-select-group">
          <label for="target-select">目标平台:</label>
          <select id="target-select" class="select-input">
            <option value="st">SillyTavern (ST 摊平)</option>
            <option value="l">Luker (带清单)</option>
            <option value="tt">TauriTavern (TT 布局)</option>
            <option value="pt" selected>PureTavern (PT 兼容)</option>
          </select>
        </div>

        <div class="compression-select-group">
          <label for="compression-select">Zip 压缩率:</label>
          <select id="compression-select" class="select-input">
            <option value="5" selected>标准均衡 (Deflate 5)</option>
            <option value="0">极速存储 (Store 0 / 秒级导出)</option>
            <option value="1">快速轻度 (Deflate 1)</option>
            <option value="9">极限压缩 (Deflate 9 / 最小体积)</option>
          </select>
        </div>

        <div class="split-select-group">
          <label for="split-select">智能分包:</label>
          <select id="split-select" class="select-input">
            <option value="none">不分卷 (单包导出)</option>
            <option value="100" selected>100 MB (云酒馆推荐 / 独立分卷)</option>
            <option value="50">50 MB (高限制容器环境)</option>
            <option value="200">200 MB (宽松上限)</option>
          </select>
        </div>

        <div class="filename-input-group">
          <div class="filename-top-row">
            <label for="filename-template-input">自定义包名:</label>
            <div class="placeholder-chips" id="placeholder-chips">
              <button type="button" class="btn-chip" data-insert="{part}" title="插入分卷序号 (如 part1, part2)">+ {part}</button>
              <button type="button" class="btn-chip" data-insert="{user}" title="插入用户名">+ {user}</button>
              <button type="button" class="btn-chip" data-insert="{date}" title="插入年月日">+ {date}</button>
              <button type="button" class="btn-chip" data-insert="{category}" title="插入类目标识">+ {category}</button>
              <button type="button" class="btn-chip" data-insert="{mode}" title="插入打包模式">+ {mode}</button>
              <button type="button" class="btn-chip" data-insert="{target}" title="插入目标平台代码">+ {target}</button>
            </div>
          </div>
          <input type="text" id="filename-template-input" class="text-input" placeholder="{target}_{user}_{part}_{date}.zip" value="{target}_{user}_{part}_{date}.zip">
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 3px; font-size: 0.76rem; color: #a6adc8;">
            <span>预设模板:</span>
            <button type="button" class="btn-tpl-preset" data-tpl="{target}_{user}_{part}_{date}.zip" style="background: transparent; border: none; color: #f59e0b; cursor: pointer; text-decoration: underline; padding: 0;">📦 分卷标准</button> |
            <button type="button" class="btn-tpl-preset" data-tpl="{target}_core_{user}_{date}.zip" style="background: transparent; border: none; color: #f59e0b; cursor: pointer; text-decoration: underline; padding: 0;">🛡️ 核心备份</button> |
            <button type="button" class="btn-tpl-preset" data-tpl="{target}_full_{user}_{date}.zip" style="background: transparent; border: none; color: #f59e0b; cursor: pointer; text-decoration: underline; padding: 0;">💾 全量备份</button>
          </div>
          <div class="filename-preview-box" id="filename-preview-box" style="margin-top: 5px;">
            <span class="preview-label">实时生成预览:</span>
            <code class="preview-code" id="filename-preview">pt_default-user_part1_2026-09-06.zip</code>
          </div>
          <span class="filename-guide">点击药丸标签可快速插入变量，生成时自动替换并过滤非法字符</span>
        </div>

        <!-- 扩展插件处理模式 (防 408 超时与体积优化) -->
        <div class="extension-mode-section" style="width: 100%; margin: 8px 0 12px 0;">
          <div style="font-size: 0.88rem; font-weight: bold; margin-bottom: 8px; color: #cdd6f4; display: flex; align-items: center; gap: 6px;">
            <span>🧩</span> 扩展打包模式:
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px;">
            <label style="display: flex; gap: 10px; padding: 10px 14px; background: rgba(137, 180, 250, 0.08); border: 1px solid rgba(137, 180, 250, 0.3); border-radius: 8px; cursor: pointer; align-items: flex-start;">
              <input type="radio" name="extension-mode" value="manifest" checked style="margin-top: 3px; cursor: pointer;">
              <div>
                <strong style="color: #89b4fa; font-size: 0.9rem;">⚡ 轻量清单模式 (推荐)</strong>
                <p style="margin: 3px 0 0 0; font-size: 0.78rem; color: #a6adc8; line-height: 1.35;">
                  体积缩减 99%，彻底防止 408 上传超时。仅导出扩展元数据清单，导入时由酒馆安装器以 <code>depth: 1</code> 浅克隆自动拉取。
                </p>
              </div>
            </label>
            <label style="display: flex; gap: 10px; padding: 10px 14px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; cursor: pointer; align-items: flex-start;">
              <input type="radio" name="extension-mode" value="full" style="margin-top: 3px; cursor: pointer;">
              <div>
                <strong style="color: #cdd6f4; font-size: 0.9rem;">📦 完整离线包</strong>
                <p style="margin: 3px 0 0 0; font-size: 0.78rem; color: #a6adc8; line-height: 1.35;">
                  打包扩展实体代码与浅层 Git 结构，已过滤 node_modules、测试与构建冗余，适合完全无外网离线环境。
                </p>
              </div>
            </label>
          </div>
          <div style="margin-top: 8px; display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #7f849c;">
            <label class="checkbox-group" title="保留构建配置文件（如 webpack.config.js, vite.config.js, tsconfig.json 等）">
              <input type="checkbox" id="keep-dev-files-check">
              <span>保留构建配置 (webpack / vite / tsconfig 等)</span>
            </label>
          </div>
        </div>

        <div class="advanced-switches-group">
          <label class="checkbox-group" title="包含 backups/ 历史快照备份包">
            <input type="checkbox" id="include-backups-check" checked>
            <span>历史备份 (backups/)</span>
          </label>
          <label class="checkbox-group" title="包含缩略图与派生缓存 (thumbnails/, _cache/)">
            <input type="checkbox" id="include-cache-check">
            <span>派生缓存</span>
          </label>
          <label class="checkbox-group" title="包含应用私有设置与引擎状态">
            <input type="checkbox" id="include-private-check">
            <span>私有配置</span>
          </label>
          <label class="checkbox-group" title="增量合并模式：当包内存在相同文件时仅更新较新文件">
            <input type="checkbox" id="incremental-mode-check">
            <span>增量合并模式</span>
          </label>
          <label class="checkbox-group" title="自动识别并剔除 SillyTavern 与 Luker 系统自带的默认背景图、默认主题等静态资源，仅保留个人资产">
            <input type="checkbox" id="prune-builtin-check" checked>
            <span>剔除酒馆原生重复资产</span>
          </label>
        </div>

        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn-primary" id="btn-convert" disabled>开始转换并下载</button>
          <button class="btn-primary" id="btn-restore-luker" style="display: none; background: var(--accent-luker);" disabled>直接恢复到当前用户</button>
        </div>
      </div>
    </section>

    <!-- Section 3: 实时进度与状态 -->
    <div class="progress-container" id="progress-container">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="progress-bar-fill"></div>
      </div>
      <div class="progress-text">
        <span id="status-label">准备就绪</span>
        <span id="progress-percent">0%</span>
      </div>
    </div>

    <!-- Section 4: 转换报告卡片 -->
    <section class="card report-panel" id="report-panel">
      <h2 class="card-title">📊 转换报告与资产统计</h2>
      <div class="module-grid" id="module-grid">
        <div class="module-item"><span class="count" id="count-chars">0</span><span class="label">角色卡</span></div>
        <div class="module-item"><span class="count" id="count-chats">0</span><span class="label">聊天记录</span></div>
        <div class="module-item"><span class="count" id="count-lorebooks">0</span><span class="label">世界书</span></div>
        <div class="module-item"><span class="count" id="count-presets">0</span><span class="label">预设配置</span></div>
        <div class="module-item"><span class="count" id="count-assets">0</span><span class="label">资产与头像</span></div>
        <div class="module-item"><span class="count" id="count-extensions">0</span><span class="label">扩展</span></div>
        <div class="module-item"><span class="count" id="count-settings">0</span><span class="label">系统设置</span></div>
        <div class="module-item"><span class="count" id="count-secrets" style="color: var(--success);">0</span><span class="label">密钥(已保护)</span></div>
      </div>

      <details class="log-accordion" id="discards-accordion" style="display: none;">
        <summary id="discards-summary">丢弃项清单 (0 条)</summary>
        <pre id="discards-log"></pre>
      </details>

      <details class="log-accordion" id="filtered-accordion" style="display: none;">
        <summary id="filtered-summary" style="color: var(--accent);">脱敏与排除清单 (0 条)</summary>
        <pre id="filtered-log"></pre>
      </details>

      <details class="log-accordion" id="warnings-accordion" style="display: none;">
        <summary id="warnings-summary">警告与适配提示 (0 条)</summary>
        <pre id="warnings-log"></pre>
      </details>
    </section>

    <!-- 二次确认恢复弹窗 (内嵌于面板内部) -->
    <div class="restore-modal-overlay" id="restore-modal-overlay" style="display: none;">
      <div class="restore-modal-card">
        <h3 class="modal-title">⚠️ 确认写入/恢复至当前宿主酒馆</h3>
        <p class="modal-desc" id="restore-modal-desc">即将把数据包恢复到当前宿主酒馆当前登录用户，请选择恢复模式：</p>
        <div class="restore-mode-group">
          <label class="radio-label">
            <input type="radio" name="restore-mode" value="merge" checked>
            <div class="radio-text">
              <strong>增量合并 (推荐)</strong>
              <span>保留酒馆已有数据，仅新增缺失数据或覆盖同名冲突文件</span>
            </div>
          </label>
          <label class="radio-label">
            <input type="radio" name="restore-mode" value="overwrite">
            <div class="radio-text">
              <strong>全量覆盖</strong>
              <span>重置当前用户数据，完全替换为该数据包内容</span>
            </div>
          </label>
        </div>
        <div class="modal-buttons">
          <button type="button" class="btn-secondary" id="btn-cancel-restore">取消</button>
          <button type="button" class="btn-primary" id="btn-confirm-restore" style="background: var(--accent-luker);">确认恢复写入</button>
        </div>
      </div>
    </div>

    <footer class="app-footer">
      <p>st-zip-converter · 遵循 SillyTavern 扩展规范 · <a href="https://github.com/jiozhaoyue/st-zip-converter" target="_blank" rel="noopener">GitHub 仓库</a> · <a href="https://github.com/jiozhaoyue/st-zip-converter/fork" target="_blank" rel="noopener">Fork 并部署专属 Pages</a></p>
    </footer>
  `;
}
