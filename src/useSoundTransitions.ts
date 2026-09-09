import { onBeforeUnmount } from 'vue'
import type { GameViewTransitionDirection } from './useDiscardFlight'
import type { StudioSettings } from './contracts/settings'

export type SoundTransitionView = Pick<TrainerGameView, 'table' | 'legalActions' | 'pendingReview'>

interface SoundTransitionContext {
  blocked: boolean
  isNewGame: boolean
  mode: TrainerStatusSnapshot['mode']
  transitionDirection: GameViewTransitionDirection
}

interface UseSoundTransitionsOptions {
  settings: StudioSettings
  status: TrainerStatusSnapshot
  isBlocked: () => boolean
}

function announcementSoundEvent(type: string): string | null {
  const map: Record<string, string> = {
    pon: 'call.pon',
    daiminkan: 'call.kan',
    ankan: 'call.kan',
    kakan: 'call.kan',
    chi: 'call.chi',
    reach: 'call.riichi',
    ron: 'win.ron',
    tsumo: 'win.tsumo',
  }
  return map[type] || null
}

export function soundActionSignature(action: NonNullable<TrainerGameView['table']>['lastAction']): string {
  if (!action) return ''
  return [
    action.type || '',
    action.actor ?? '',
    action.pai || '',
    action.variant || '',
    action.target ?? '',
    action.reason || '',
    action.riichi ? '1' : '0',
    Array.isArray(action.consumed) ? action.consumed.join(',') : '',
  ].join('|')
}

function hasSpecialChoiceActions(view: SoundTransitionView): boolean {
  return (view.legalActions || []).some((action) => action.type !== 'dahai')
}

export function soundEventsForTransition(
  previous: SoundTransitionView,
  next: SoundTransitionView,
  context: SoundTransitionContext,
): string[] {
  if (context.blocked || context.isNewGame || !previous.table || !next.table) return []

  const events: string[] = []
  const hadPendingDiscard = Boolean(previous.table.pendingDiscard || previous.table.pendingRiichiDiscard)
  const hasPendingDiscard = Boolean(next.table.pendingDiscard || next.table.pendingRiichiDiscard)
  if (context.transitionDirection === 'forward' && hadPendingDiscard && !hasPendingDiscard) {
    events.push('action.confirmed')
  }

  const previousActionSignature = soundActionSignature(previous.table.lastAction)
  const nextAction = next.table.lastAction
  const nextActionSignature = soundActionSignature(nextAction)
  if (nextAction && nextActionSignature && nextActionSignature !== previousActionSignature) {
    if (nextAction.type === 'dahai') {
      events.push('tile.discard')
    } else if (nextAction.type === 'reach') {
      events.push('call.riichi')
    } else if (['chi', 'pon', 'daiminkan', 'ankan', 'kakan'].includes(nextAction.type)) {
      const event = announcementSoundEvent(nextAction.type)
      if (event) events.push(event)
    } else if (nextAction.type === 'hora') {
      const variant = nextAction.variant === 'tsumo' || nextAction.actor === nextAction.target ? 'tsumo' : 'ron'
      const event = announcementSoundEvent(variant)
      if (event) events.push(event)
    }
  }

  if (context.mode === 'play' && !hasSpecialChoiceActions(previous) && hasSpecialChoiceActions(next)) {
    events.push('action.required')
  }
  if (context.mode === 'play' && !previous.pendingReview && next.pendingReview) {
    events.push('review.required')
  }
  if (!previous.table.resultInfo && next.table.resultInfo) {
    events.push('round.result')
  }
  return events
}

export function useSoundTransitions(options: UseSoundTransitionsOptions) {
  const activeAudioPlayers = new Map<HTMLAudioElement, () => void>()

  function soundSource(event: string): string | null {
    const selectedPack = options.settings.runtime?.soundPackCatalog.packs.find(
      (pack) => pack.id === options.settings.audio.soundPackId,
    )
    return selectedPack?.sounds[event] || null
  }

  function playSoundEvent(event: string) {
    const src = soundSource(event)
    const volume = Math.max(0, Math.min(1, options.settings.audio.volume / 100))
    if (!src || volume <= 0) return
    const audio = new Audio(src)
    audio.volume = volume
    audio.preload = 'auto'
    const cleanup = () => {
      activeAudioPlayers.delete(audio)
      audio.removeEventListener('ended', cleanup)
      audio.removeEventListener('error', cleanup)
    }
    activeAudioPlayers.set(audio, cleanup)
    audio.addEventListener('ended', cleanup)
    audio.addEventListener('error', cleanup)
    void audio.play().catch(cleanup)
  }

  function handleSoundTransitions(
    previous: SoundTransitionView,
    next: SoundTransitionView,
    isNewGame: boolean,
    transitionDirection: GameViewTransitionDirection,
  ) {
    for (const event of soundEventsForTransition(previous, next, {
      blocked: options.isBlocked(),
      isNewGame,
      mode: options.status.mode,
      transitionDirection,
    })) {
      playSoundEvent(event)
    }
  }

  function stopAllSounds() {
    for (const [audio, cleanup] of activeAudioPlayers) {
      audio.pause()
      cleanup()
    }
  }

  onBeforeUnmount(stopAllSounds)

  return { handleSoundTransitions, stopAllSounds }
}
