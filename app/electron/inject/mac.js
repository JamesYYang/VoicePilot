/**
 * macOS 注入实现。
 *
 * ⚠️ 顶层绝不 koffi.load()：index.js 静态 import 了本文件。所有动态库句柄都在
 * lib() 里惰性建。
 */
export function captureTarget() {
  // Task 4 实现。在此之前返回 null —— 采纳会走「已复制，请手动粘贴」的回退路径，
  // 而不是崩溃。
  return null;
}
