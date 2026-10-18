import { useSyncExternalStore } from 'react';
import { korean } from './locales';

export type Language = 'ko' | 'en';
export type TranslationParams = Readonly<Record<string, string | number | boolean | null | undefined>>;
const storageKey = 'dockslate.language';
const valid = (value: unknown): value is Language => value === 'ko' || value === 'en';
function readLanguage(): Language {
  try { const value = typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey); return valid(value) ? value : 'ko'; }
  catch { return 'ko'; }
}
let language = readLanguage();
if (typeof document !== 'undefined') document.documentElement.lang = language;
const listeners = new Set<() => void>();
let english: Readonly<Record<string, string>> = {};
let englishRequest: Promise<void> | null = null;
let selection = 0;
function loadEnglish(): Promise<void> {
  if (englishRequest) return englishRequest;
  englishRequest = import('./locales.en').then(module => { english = module.english; }).catch(error => { englishRequest = null; throw error; });
  return englishRequest;
}
export async function initializeLanguage(): Promise<void> {
  if (language === 'en') {
    try { await loadEnglish(); }
    catch { language = 'ko'; document.documentElement.lang = language; }
  }
}
export const getLanguage = (): Language => language;
export const getLocale = (): 'ko-KR' | 'en-US' => language === 'en' ? 'en-US' : 'ko-KR';
export async function setLanguage(value: Language): Promise<void> {
  if (!valid(value)) return;
  const request = ++selection;
  if (value === 'en') await loadEnglish();
  if (request !== selection) return;
  try { window.localStorage.setItem(storageKey, value); } catch { /* Storage unavailable */ }
  if (language === value) return;
  language = value;
  document.documentElement.lang = value;
  listeners.forEach(listener => listener());
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== storageKey || !valid(event.newValue) || event.newValue === language) return;
  void setLanguage(event.newValue).catch(() => {});
});
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useLanguage(): Language { return useSyncExternalStore(subscribe, getLanguage, () => 'ko'); }
export function t(original: string, params?: TranslationParams): string {
  const translated = (language === 'en' ? english[original] : korean[original]) ?? original;
  if (!params) return translated;
  return translated.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, key: string) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key] ?? '') : placeholder);
}
