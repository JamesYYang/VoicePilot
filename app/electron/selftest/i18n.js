import { t, resolveLocale, isLocale, LOCALES, DICTS } from '../../shared/i18n/index.js';
import { getCurrentLocale, setCurrentLocale } from '../locale.js';
import { openStore, getMeta } from '../store.js';
import { toTraditional } from '../i18n/zh-convert.js';

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
  // 直接取三本字典的 key 集合比较。旧实现用 Object.keys(t(l, '__x'))——缺 key 时 t 返回
  // key 字符串本身，Object.keys('__x') 恒为 ['0','1','2']，等于从没比过任何东西。
  // 这里逐 locale 建 Set，要求「大小相等且互含」，才能发现「数量相同但 key 不同」的漂移。
  const keySets = LOCALES.map((l) => new Set(Object.keys(DICTS[l])));
  const okSameKeys = keySets.every(
    (s) => s.size === keySets[0].size && [...s].every((k) => keySets[0].has(k))
  );
  const ok = okT && okParams && okMissing && okResolve && okIs && okSameKeys;

  // locale 单一真源 + 持久化（vp:lang/set → setCurrentLocale → setMeta）
  openStore(':memory:');
  setCurrentLocale('zh-TW');
  const okPersist = getCurrentLocale() === 'zh-TW' && getMeta('ui_language') === 'zh-TW';
  const okReject = setCurrentLocale('ja') === false;

  // 简→繁：zh-TW 下转换；非 zh-TW 原样返回
  const tw = await toTraditional('我们在讨论语音输入');
  const okZh = tw.includes('我們') && tw.includes('語音');
  setCurrentLocale('zh-CN');
  const okNoop = (await toTraditional('我们在讨论语音输入')) === '我们在讨论语音输入';

  const okAll = ok && okPersist && okReject && okZh && okNoop;
  console.log(`[自测] ${okAll ? '通过' : '失败'} t=${okT} 占位=${okParams} 缺key=${okMissing} 映射=${okResolve} isLocale=${okIs} 三语同key=${okSameKeys} 持久化=${okPersist} 非法拒绝=${okReject} 简繁=${okZh} 非TW原样=${okNoop}`);
  return { ok: okAll };
}
