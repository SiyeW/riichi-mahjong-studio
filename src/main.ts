import { createApp } from 'vue'
import App from './App.vue'
import { setLanguagePreference, translate } from './i18n'
import './styles.css'

setLanguagePreference('system')

const app = createApp(App)
app.config.globalProperties.$t = translate
app.mount('#app')
