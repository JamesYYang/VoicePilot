import { zhCN } from './zh-CN.js';
import { zhTW } from './zh-TW.js';
import { enUS } from './en-US.js';

export const LOCALES = ['zh-CN', 'zh-TW', 'en-US'];
export const DICTS = { 'zh-CN': zhCN, 'zh-TW': zhTW, 'en-US': enUS };

export function isLocale(x) {
  return typeof x === 'string' && LOCALES.includes(x);
}

/** 系统语言 → 三语之一；未知一律 en-US。 */
export function resolveLocale(sysLocale) {
  const s = String(sysLocale ?? '').toLowerCase();
  if (s.startsWith('zh')) {
    if (s.includes('tw') || s.includes('hk') || s.includes('mo')) return 'zh-TW';
    return 'zh-CN';
  }
  if (s.startsWith('en')) return 'en-US';
  return 'en-US';
}

/** 翻译。缺 key 返回 key 本身（便于发现遗漏）；{{name}} 占位符替换。 */
export function t(locale, key, params = {}) {
  const dict = DICTS[locale] ?? enUS;
  const raw = dict[key];
  if (raw == null) return key;
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    name in params ? String(params[name]) : `{{${name}}}`
  );
}
