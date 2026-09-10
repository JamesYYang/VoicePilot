import { t, resolveLocale, isLocale, LOCALES } from '../../shared/i18n/index.js';
import { getCurrentLocale, setCurrentLocale } from '../locale.js';
import { openStore, getMeta } from '../store.js';

export async function runI18nSelftest() {
  console.log('[自测] i18n 字典');
  const okT = t('zh-CN', 'bar.listening') === '聆听中' &&
    t('zh-TW', 'bar.listening') === '聆聽中' &&
    t('en-US', 'bar.listening') === 'Listening';
  const okParams = t('en-US', 'bar.retry', { attempt: 2, max: 3 }) === '(retry 2/3)';
  const okMissing = t('zh-CN', 'nope.nope') === 'nope.nope';
  const okResolve = resolveLocale('zh-CN') === 'zh-CN' &&
    resolveLocale('zh-TW') === 'zh-TW' &&
    resolveLocale('zh-HK') === 'zh-TW' &&
    resolveLocale('en') === 'en-US' &&
    resolveLocale('ja') === 'en-US' &&
    resolveLocale(null) === 'en-US';
  const okIs = isLocale('zh-CN') && !isLocale('ja') && !isLocale(3);
  const okSameKeys = new Set(LOCALES.map((l) => Object.keys(t(l, '__x')).length)).size <= 1;
  const ok = okT && okParams && okMissing && okResolve && okIs;

  // locale 单一真源 + 持久化（vp:lang/set → setCurrentLocale → setMeta）
  openStore(':memory:');
  setCurrentLocale('zh-TW');
  const okPersist = getCurrentLocale() === 'zh-TW' && getMeta('ui_language') === 'zh-TW';
  const okReject = setCurrentLocale('ja') === false;

  const okAll = ok && okPersist && okReject;
  console.log(`[自测] ${okAll ? '通过' : '失败'} t=${okT} 占位=${okParams} 缺key=${okMissing} 映射=${okResolve} isLocale=${okIs} 持久化=${okPersist} 非法拒绝=${okReject}`);
  return { ok: okAll };
}
