import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { t, resolveLocale } from '../shared/i18n/index.js';

type Locale = 'zh-CN' | 'zh-TW' | 'en-US';

const LocaleContext = createContext<Locale>('zh-CN');

export function I18nProvider({ bridge, children }: {
  bridge?: Window['voicepilot'];
  children: ReactNode;
}) {
  const vp = bridge ?? window.voicepilot;
  const [locale, setLocale] = useState<Locale>(() =>
    resolveLocale(typeof navigator !== 'undefined' ? navigator.language : null)
  );

  useEffect(() => {
    void vp.getLanguage().then((r) => setLocale(r.locale));
    const off = vp.onLanguageChanged((l) => setLocale(l));
    return off;
  }, [vp]);

  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT() {
  const locale = useLocale();
  return (key: string, params?: Record<string, string | number>) => t(locale, key, params);
}
