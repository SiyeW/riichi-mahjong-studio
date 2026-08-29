import { createApp } from 'vue'
import App from './App.vue'
import { setLanguagePreference, translate } from './i18n'
import { uiTooltip } from './uiTooltip'
import './styles.css'

setLanguagePreference('system')

const app = createApp(App)
app.config.globalProperties.$t = translate
app.directive('ui-tooltip', uiTooltip)
app.mount('#app')
