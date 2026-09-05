import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 渲染进程构建配置。
 *
 * 输出目录单独放在 dist/renderer，与 electron-builder 的打包产物隔离，
 * 避免主进程代码被 Vite 处理（主进程是纯 ESM，Electron 直接加载，不编译）。
 *
 * base 必须是相对路径 './'：默认的 '/' 在 file:// 下会解析到文件系统根目录，
 * 资源全 404。
 *
 * 注意：渲染进程**不通过 file:// 加载**，而是走主进程注册的 app:// 自定义协议
 * （见 electron/main.js）。原因是 Chromium 把 file:// 当不透明源，会拒绝加载
 * ES module，且不报错 —— 表现是窗口一片空白，极难排查。
 * 自定义协议是 secure + standard 的源，ESM / fetch / Web Audio 全部正常。
 */
export default defineConfig({
  root: HERE,
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
