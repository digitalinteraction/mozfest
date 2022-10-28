import Vue from 'vue'
import VueI18n from 'vue-i18n'

import en from './en.yml'

Vue.use(VueI18n)

const rtlLocales = new Set(['ar'])

const i18n = new VueI18n({
  locale: pickLocale(),
  messages: { en },
})

export function pickLocale() {
  return (
    localStorage.getItem('locale') ??
    getBrowserLocale(window.navigator.language)
  )
}

export function getBrowserLocale(input = 'en') {
  const specific = /(\w+)-\w+/.exec(input)
  return specific ? specific[1] : input
}

export function setLocale(newLocale: string = getBrowserLocale()): void {
  i18n.locale = newLocale
  updateDocumentDirection(newLocale)
  localStorage.setItem('locale', newLocale)
}

function updateDocumentDirection(locale: string) {
  const html = document.documentElement
  html.setAttribute('lang', locale)
  html.setAttribute('dir', rtlLocales.has(locale) ? 'rtl' : 'ltr')
}

updateDocumentDirection(i18n.locale)

export default i18n
