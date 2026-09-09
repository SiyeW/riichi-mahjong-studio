import type { TranslationParams } from './i18n'
import type { GameAction, GameView } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'

type Translate = (key: string, params?: TranslationParams) => string

export function useMahjongPresentationLabels(options: {
  gameView: GameView
  status: StudioStatus
  t: Translate
}) {
  const { gameView, status, t } = options

  function relativeSeatLabel(seat: number): string {
    const diff = (seat - status.controlledSeat + 4) % 4
    return [t('seat.self'), t('seat.shimocha'), t('seat.toimen'), t('seat.kamicha')][diff]
      ?? t('seat.number', { seat })
  }

  function seatWindLabel(seat: number): string {
    const dealer = gameView.table?.dealer ?? 0
    const windIndex = (seat - dealer + 4) % 4
    return [t('wind.east'), t('wind.south'), t('wind.west'), t('wind.north')][windIndex] ?? '?'
  }

  function isCurrentActorSeat(seat: number): boolean {
    if (['game_end', 'round_result', 'match_end'].includes(gameView.table?.phase || '')) return false
    return gameView.table?.currentActor === seat
  }

  function roundWindLabel(bakaze: string): string {
    return ({ E: t('wind.east'), S: t('wind.south'), W: t('wind.west'), N: t('wind.north') } as Record<string, string>)[bakaze] || bakaze
  }

  function tileFaceLabel(tile: string): string {
    if (!tile || tile === '?') return ' '
    const honorMap: Record<string, string> = {
      E: t('wind.east'), S: t('wind.south'), W: t('wind.west'), N: t('wind.north'),
      P: t('tile.white'), F: t('tile.green'), C: t('tile.red'),
    }
    if (honorMap[tile]) return honorMap[tile]
    const isRed = tile.endsWith('r')
    const base = isRed ? tile.slice(0, -1) : tile
    return isRed ? t('tile.redPrefix', { tile: base }) : base
  }

  function reactionTypeLabel(type: string): string {
    return {
      none: t('action.skip'),
      chi: t('action.chi'),
      chi_low: t('action.chi'),
      chi_mid: t('action.chi'),
      chi_high: t('action.chi'),
      pon: t('action.pon'),
      daiminkan: t('action.kan'),
      ankan: t('action.kan'),
      kakan: t('action.kan'),
      hora: t('action.ron'),
      reach: t('action.riichi'),
      reach_accepted: t('action.riichiAccepted'),
      dahai: t('action.discard'),
      tsumo: t('action.draw'),
      round_result: t('action.roundResult'),
      game_end: t('action.matchEnd'),
      match_end: t('action.matchEnd'),
      start_kyoku: t('action.roundStart'),
    }[type] || type
  }

  function ryukyokuActionLabel(action: Record<string, unknown>): string {
    const reason = String(action.reason || action.variant || '')
    const knownReasons: Record<string, string> = {
      exhaustive_draw: t('draw.exhaustive'),
      kyuushu_kyuuhai: t('draw.kyuushu'),
      suufon_renda: t('draw.suufon'),
      suukantsu: t('draw.suukantsu'),
      suucha_riichi: t('draw.suuchaRiichi'),
    }
    if (knownReasons[reason]) return knownReasons[reason]
    const reasonLabel = String(action.reasonLabel || '').trim()
    const knownLabels: Record<string, string> = {
      '': t('draw.exhaustive'),
      '流局': t('draw.exhaustive'),
      '荒牌流局': t('draw.exhaustive'),
      '九種九牌': t('draw.kyuushu'),
      '九种九牌': t('draw.kyuushu'),
      '四風連打': t('draw.suufon'),
      '四风连打': t('draw.suufon'),
      '四槓散了': t('draw.suukantsu'),
      '四杠散了': t('draw.suukantsu'),
      '四家立直': t('draw.suuchaRiichi'),
    }
    return knownLabels[reasonLabel] || reasonLabel
  }

  function specialActionLabel(action: GameAction): string {
    if (action.type === 'hora') return action.variant === 'tsumo' ? t('action.tsumo') : t('action.ron')
    if (action.type === 'ryukyoku') return ryukyokuActionLabel(action as unknown as Record<string, unknown>)
    if (action.type === 'reach') return t('action.riichi')
    if (action.type === 'none') return t('action.skip')
    if (action.type === 'chi') return t('action.chi')
    if (action.type === 'pon') return t('action.pon')
    if (action.type === 'daiminkan' || action.type === 'ankan' || action.type === 'kakan') return t('action.kan')
    return reactionTypeLabel(action.type)
  }

  function normalizeTileFamily(tile: string): string {
    return String(tile).replace('5mr', '5m').replace('5pr', '5p').replace('5sr', '5s').replace(/r$/, '')
  }

  function redFive(tile: string): string {
    if (tile === '5m') return '0m'
    if (tile === '5p') return '0p'
    if (tile === '5s') return '0s'
    return tile
  }

  return {
    relativeSeatLabel,
    seatWindLabel,
    isCurrentActorSeat,
    roundWindLabel,
    tileFaceLabel,
    reactionTypeLabel,
    ryukyokuActionLabel,
    specialActionLabel,
    normalizeTileFamily,
    redFive,
  }
}

export type MahjongPresentationLabels = ReturnType<typeof useMahjongPresentationLabels>
