/**
 * st-zip-converter 主入口脚本 (ESM)
 * 具备三位一体自适应能力:
 * 1. 独立运行 (本地开发服务 / GitHub Pages)
 * 2. SillyTavern / Luker 第三方扩展插件模式
 */

console.log('[st-zip-converter] 初始化加载中...');

function detectEnvironment() {
  const isLuker = typeof window.luker !== 'undefined' || Boolean(document.querySelector('#luker-app'));
  const isST = typeof window.SillyTavern !== 'undefined' || Boolean(document.querySelector('#extensionsMenu'));
  if (isLuker) return 'luker';
  if (isST) return 'st';
  return 'standalone';
}

function initApp() {
  const env = detectEnvironment();
  const envBadge = document.getElementById('env-badge');
  const hostExportCard = document.getElementById('host-export-card');

  if (envBadge) {
    if (env === 'st') {
      envBadge.textContent = 'SillyTavern 插件模式';
      envBadge.style.color = 'var(--accent-st)';
      envBadge.style.borderColor = 'var(--accent-st)';
    } else if (env === 'luker') {
      envBadge.textContent = 'Luker 插件模式';
      envBadge.style.color = 'var(--accent-luker)';
      envBadge.style.borderColor = 'var(--accent-luker)';
    } else {
      envBadge.textContent = '独立 Web 模式';
    }
  }

  if (env !== 'standalone' && hostExportCard) {
    hostExportCard.style.display = 'block';
  }

  console.log(`[st-zip-converter] 当前运行环境: ${env}`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
