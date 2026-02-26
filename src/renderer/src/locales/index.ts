import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings-store'

import enCommon from './en/common.json'
import enLayout from './en/layout.json'
import enChat from './en/chat.json'
import enSettings from './en/settings.json'
import enCowork from './en/cowork.json'
import enAgent from './en/agent.json'
import enSsh from './en/ssh.json'

import zhCommon from './zh/common.json'
import zhLayout from './zh/layout.json'
import zhChat from './zh/chat.json'
import zhSettings from './zh/settings.json'
import zhCowork from './zh/cowork.json'
import zhAgent from './zh/agent.json'
import zhSsh from './zh/ssh.json'

i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: enCommon,
      layout: enLayout,
      chat: enChat,
      settings: enSettings,
      cowork: enCowork,
      agent: enAgent,
      ssh: enSsh,
    },
    zh: {
      common: zhCommon,
      layout: zhLayout,
      chat: zhChat,
      settings: zhSettings,
      cowork: zhCowork,
      agent: zhAgent,
      ssh: zhSsh,
    },
  },
  lng: useSettingsStore.getState().language,
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
