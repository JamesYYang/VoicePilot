import { createRoot } from 'react-dom/client';
import App from './App';
import DiagPanel from './diag/DiagPanel';

const found = document.getElementById('root');
if (!found) throw new Error('找不到 #root 挂载点');
// 单独存一份非空引用：外面的 if 判断无法把收窄带进 boot() 这个异步函数里
const container: HTMLElement = found;

// 一仓多窗：同一份渲染产物，按 hash 决定渲染哪块。
//   #diag    → M1 采集诊断面板（独立可聚焦窗口，见 electron/main.js 的 createDiagWindow）
//   #uitest  → 悬浮条界面自测（VP_UI_SELFTEST=1 时自动跑）
//   其他     → 悬浮条
//
// 注意要先剥掉查询串再比：自动跑模式下 hash 是 `#diag?autorun=8000`，
// 直接拿 '#diag' 做全等比较会静默渲染成悬浮条 UI —— 表现是窗口开着、
// 什么都不发生，极难排查。
const [route] = location.hash.replace(/^#/, '').split('?');

async function boot() {
  if (route === 'uitest') {
    const { runUiTest } = await import('./uitest/run');
    try {
      const r = await runUiTest();
      window.voicepilot.reportUiTestResult(r);
    } catch (e) {
      console.error(`[界面自测] 异常终止：${e instanceof Error ? e.stack : e}`);
      window.voicepilot.reportUiTestResult({ ok: false, failed: -1, total: -1 });
    }
    return;
  }

  if (route === 'studio') {
    const { default: Studio } = await import('./studio/Studio');
    createRoot(container).render(<Studio />);
    return;
  }

  if (route === 'onboarding') {
    const { default: Onboarding } = await import('./onboarding/Onboarding');
    createRoot(container).render(<Onboarding />);
    return;
  }

  if (route === 'key-entry') {
    const { default: KeyEntry } = await import('./key-entry/KeyEntry');
    createRoot(container).render(<KeyEntry />);
    return;
  }

  createRoot(container).render(route === 'diag' ? <DiagPanel /> : <App />);
}

void boot();
