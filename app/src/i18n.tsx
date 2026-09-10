import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../shared/i18n/index.js';

type Locale = 'zh-CN' | 'zh-TW' | 'en-US';

const LocaleContext = createContext<Locale>('zh-CN');

export function I18nProvider({ bridge, children }: {
  bridge?: Window['voicepilot'];
  children: ReactNode;
}) {
  const vp = bridge ?? window.voicepilot;
  // 初始为 null（「加载中」哨兵）：主进程 locale 是单一真源，挂载后经
  // getLanguage() 拉回。不能用 navigator.language 先渲染一帧 —— 用户持久化语言
  // 与系统语言不一致时会闪一帧错误语言。
  const [locale, setLocale] = useState<Locale | null>(null);

  useEffect(() => {
    void vp.getLanguage().then((r) => setLocale(r.locale));
    const off = vp.onLanguageChanged((l) => setLocale(l));
    return off;
  }, [vp]);

  // getLanguage 返回前不渲染子树，避免错误语言闪帧
  if (locale === null) return null;
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT() {
  const locale = useLocale();
  return (key: string, params?: Record<string, string | number>) => t(locale, key, params);
}
