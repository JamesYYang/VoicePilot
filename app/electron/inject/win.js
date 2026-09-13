import koffi from 'koffi';

/**
 * Windows 注入实现。
 *
 * ⚠️ 顶层绝不 koffi.load()：index.js 静态 import 了本文件，macOS 上
 * koffi.load('user32.dll') 会在应用启动时抛。所有动态库句柄都在 lib() 里惰性建。
 */

let api = null;

/** 惰性建一次动态库句柄与函数声明。 */
function lib() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  api = {
    // HWND 一律用 uintptr_t。实测 koffi 3.2.1 下 uintptr_t 返回 **number**，可直接 !== 比较；
    // 不能用 `void*`（返回的是指针值，不可比数值）。
    GetForegroundWindow: user32.func('uintptr_t GetForegroundWindow()'),
  };
  return api;
}

/** 取当前前台窗口。拿不到返回 null。 */
export function captureTarget() {
  const hwnd = lib().GetForegroundWindow();
  // 0 表示没有前台窗口（例如焦点在桌面上）。当作「没捕获到」，采纳时走回退路径。
  if (!hwnd) return null;
  return { kind: 'win', hwnd };
}
