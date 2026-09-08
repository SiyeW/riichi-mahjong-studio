import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { TranslationParams } from './i18n'

type Translate = (key: string, params?: TranslationParams) => string

interface UseActionAnnouncementOptions {
  gameView: TrainerGameView
  findNode: (nodeId: string) => TrainerTreeNode | undefined
  positionForActor: (actor: number) => string
  t: Translate
}

export function resolveActionAnnouncementText(node: TrainerTreeNode | null | undefined, t: Translate): string | null {
  if (!node?.action) return null
  const action = node.action
  const type = String(action.type || '')
  if (type === 'reach') return t('action.riichi')
  if (type === 'chi') return t('action.chi')
  if (type === 'pon') return t('action.pon')
  if (type === 'daiminkan' || type === 'ankan' || type === 'kakan') return t('action.kan')
  if (type === 'hora') {
    const actor = Number(action.actor ?? -1)
    const target = Number(action.target ?? -999)
    return action.variant === 'tsumo' || actor === target ? t('action.tsumo') : t('action.ronShort')
  }
  return null
}

export function useActionAnnouncement(options: UseActionAnnouncementOptions) {
  const timer = ref<number | null>(null)
  const actionAnnouncement = reactive({
    key: '',
    text: '',
    position: 'south',
    visible: false,
  })

  function clearTimer() {
    if (timer.value === null) return
    window.clearTimeout(timer.value)
    timer.value = null
  }

  function showCurrentAction() {
    const nodeId = options.gameView.currentNodeId
    if (!nodeId) return
    const node = options.findNode(nodeId)
    const text = resolveActionAnnouncementText(node, options.t)
    if (!text) return
    const actor = Number(node?.action?.actor ?? -1)
    clearTimer()
    actionAnnouncement.key = `${nodeId}:${text}:${Date.now()}`
    actionAnnouncement.text = text
    actionAnnouncement.position = options.positionForActor(actor)
    actionAnnouncement.visible = true
    timer.value = window.setTimeout(() => {
      actionAnnouncement.visible = false
      timer.value = null
    }, 1500)
  }

  watch(() => options.gameView.currentNodeId, showCurrentAction)
  onBeforeUnmount(clearTimer)

  return { actionAnnouncement }
}
