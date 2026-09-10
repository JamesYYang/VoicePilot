import { app } from 'electron';
import { resolveLocale, isLocale } from '../shared/i18n/index.js';
import { getMeta, setMeta } from './store.js';

let current = null;

export function getCurrentLocale() {
  if (current === null) {
    current = resolveLocale(getMeta('ui_language') ?? app.getLocale());
  }
  return current;
}

export function setCurrentLocale(locale) {
  if (!isLocale(locale)) return false;
  current = locale;
  setMeta('ui_language', locale);
  return true;
}
