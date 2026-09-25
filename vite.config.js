import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  // 端口显式声明 + strictPort（L0-16：禁止占用出厂/通用默认端口）。
  // 5173 是 Vite 默认端口，**不能占**——env-sync 桌面应用的 Tauri `devUrl` 就是
  // `http://localhost:5173`，占用它会使其 GUI 窗口加载到本插件页面（2026-09-25 实测事故）。
  server: {
    port: 3040,
    strictPort: true,
  },
  // 4173 已在 L0-16 登记为 Vite preview
  preview: {
    port: 4173,
    strictPort: true,
  },
});
