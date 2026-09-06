import { createRoot } from 'react-dom/client';
import App from './App';
import DiagPanel from './diag/DiagPanel';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

// 一仓两窗：同一个渲染产物，按 hash 决定渲染哪块。
//   #diag → M1 采集诊断面板（独立可聚焦窗口，见 electron/main.js 的 createDiagWindow）
//   其他   → 悬浮条
// 诊断面板不能塞进悬浮条：悬浮条 focusable:false 且默认鼠标穿透，按钮点不到。
//
// 注意要先剥掉查询串再比：自动跑模式下 hash 是 `#diag?autorun=8000`，
// 直接拿 '#diag' 做全等比较会静默渲染成悬浮条 UI —— 表现是窗口开着、
// 什么都不发生，极难排查。
const [route] = location.hash.replace(/^#/, '').split('?');
createRoot(container).render(route === 'diag' ? <DiagPanel /> : <App />);
