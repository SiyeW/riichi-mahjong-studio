import type { App } from 'vue'
import { translate as t } from './i18n'
import { rendererRecovery } from './rendererRecoveryState'
import './styles/RendererRecovery.css'

/** This surface must survive a broken Vue root. Use DOM nodes and shared modal
 * primitives, not another component in the failed application tree. */
export function installRendererRecovery(app: App) {
  let surface: HTMLElement | null = null
  app.config.errorHandler = (error, _instance, info) => {
    console.error('[renderer]', info, error)
    if (surface) return
    surface = document.createElement('div')
    // Reuse the shell's typography/scale tokens without keeping it in Vue's DOM.
    const shell = document.querySelector('.shell') || document.body
    surface.className = 'shell settings-modal-backdrop renderer-recovery'
    surface.style.setProperty('--ui-scale', getComputedStyle(shell).getPropertyValue('--ui-scale') || '1')
    const panel = document.createElement('section')
    panel.className = 'settings-modal'
    panel.setAttribute('role', 'alertdialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-labelledby', 'renderer-recovery-title')
    const header = document.createElement('div')
    header.className = 'settings-modal-header'
    const title = document.createElement('h2')
    title.id = 'renderer-recovery-title'
    title.textContent = t('rendererRecovery.title')
    header.append(title)
    const message = document.createElement('p')
    message.textContent = t('rendererRecovery.message')
    const detail = document.createElement('p')
    detail.className = 'renderer-recovery-detail'
    detail.textContent = error instanceof Error ? error.message : String(error)
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    const actions = document.createElement('div')
    actions.className = 'settings-modal-actions'
    const button = document.createElement('button')
    button.className = 'settings-btn-secondary'
    button.textContent = t('rendererRecovery.reload')
    button.onclick = async () => {
      button.disabled = true
      status.textContent = t('rendererRecovery.flushing')
      try {
        await rendererRecovery.recover()
      } catch (failure) {
        status.textContent = t('rendererRecovery.failed', {
          message: failure instanceof Error ? failure.message : String(failure),
        })
        button.disabled = false
      }
    }
    actions.append(button)
    panel.append(header, message, detail, status, actions)
    surface.append(panel)
    document.body.append(surface)
    // Make stale controls unreachable to both pointer and keyboard input.
    document.getElementById('app')?.setAttribute('inert', '')
    button.focus()
  }
}
