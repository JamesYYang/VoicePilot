export type Locale = 'zh-CN' | 'zh-TW' | 'en-US';
export const LOCALES: Locale[];
export function isLocale(x: unknown): x is Locale;
export function resolveLocale(sysLocale: string | null | undefined): Locale;
export function t(
  locale: string,
  key: string,
  params?: Record<string, string | number>
): string;
