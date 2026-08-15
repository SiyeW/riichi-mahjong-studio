import { computed, readonly, ref } from 'vue'
import enUS from '../locales/en-US.json'
import jaJP from '../locales/ja-JP.json'
import zhCN from '../locales/zh-CN.json'

export const SUPPORTED_LOCALES = ['zh-CN', 'ja-JP', 'en-US'] as const
export type SupportedLocale = typeof SUPPORTED_LOCALES[number]
export type LanguagePreference = 'system' | SupportedLocale
export type TranslationParams = Record<string, string | number>

const catalogs: Record<SupportedLocale, Record<string, string>> = {
  'zh-CN': zhCN,
  'ja-JP': jaJP,
  'en-US': enUS,
}

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? [...navigator.languages] : [navigator.language]
}

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return value === 'zh-CN' || value === 'ja-JP' || value === 'en-US' ? value : 'system'
}

export function resolveSystemLocale(languages: readonly string[] = browserLanguages()): SupportedLocale {
  for (const language of languages) {
    const normalized = String(language || '').toLowerCase()
    if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja-JP'
    if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US'
  }
  return 'en-US'
}

const languagePreference = ref<LanguagePreference>('system')
const activeLocale = ref<SupportedLocale>(resolveSystemLocale())

function applyDocumentLanguage(locale: SupportedLocale) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.documentElement.dataset.locale = locale
  document.documentElement.dir = 'ltr'
}

export function setLanguagePreference(value: unknown) {
  const preference = normalizeLanguagePreference(value)
  languagePreference.value = preference
  activeLocale.value = preference === 'system' ? resolveSystemLocale() : preference
  applyDocumentLanguage(activeLocale.value)
}

export function translate(key: string, params: TranslationParams = {}): string {
  const template = catalogs[activeLocale.value][key] ?? catalogs['zh-CN'][key] ?? key
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ))
}

export function useI18n() {
  return {
    locale: readonly(activeLocale),
    localePreference: readonly(languagePreference),
    numberLocale: computed(() => activeLocale.value),
    setLanguagePreference,
    t: translate,
  }
}

setLanguagePreference('system')
