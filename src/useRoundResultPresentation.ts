import { computed } from 'vue'

type Translate = (key: string, params?: Record<string, string | number>) => string

export function localizedResultTitle(value: unknown, t: Translate): string {
  const title = String(value || '').trim()
  const key = ({
    '终局': 'action.matchEnd',
    '終局': 'action.matchEnd',
    '进行中': 'result.inProgress',
    '進行中': 'result.inProgress',
    '流局': 'action.drawResult',
    '和牌': 'action.win',
    '和了': 'action.win',
  } as Record<string, string>)[title]
  return key ? t(key) : title
}

interface YakuDisplayMeta {
  closedHan: number
  openHan: number
  isYakuman?: boolean
}

interface ResultYakuItem {
  name: string
  label: string
  han: number
  isYakuman: boolean
}

const YAKU_DISPLAY_META: Record<string, YakuDisplayMeta> = {
  'Menzen Tsumo': { closedHan: 1, openHan: 0 },
  Riichi: { closedHan: 1, openHan: 0 },
  Ippatsu: { closedHan: 1, openHan: 0 },
  Pinfu: { closedHan: 1, openHan: 0 },
  Tanyao: { closedHan: 1, openHan: 1 },
  Iipeiko: { closedHan: 1, openHan: 0 },
  'Yakuhai (haku)': { closedHan: 1, openHan: 1 },
  'Yakuhai (hatsu)': { closedHan: 1, openHan: 1 },
  'Yakuhai (chun)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind east)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind south)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind west)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind north)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind east)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind south)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind west)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind north)': { closedHan: 1, openHan: 1 },
  'Rinshan Kaihou': { closedHan: 1, openHan: 1 },
  Chankan: { closedHan: 1, openHan: 1 },
  'Haitei Raoyue': { closedHan: 1, openHan: 1 },
  'Houtei Raoyui': { closedHan: 1, openHan: 1 },
  'Double Riichi': { closedHan: 2, openHan: 0 },
  'Open Riichi': { closedHan: 2, openHan: 0 },
  'Double Open Riichi': { closedHan: 3, openHan: 0 },
  Chiitoitsu: { closedHan: 2, openHan: 0 },
  Chantai: { closedHan: 2, openHan: 1 },
  Ittsu: { closedHan: 2, openHan: 1 },
  'Sanshoku Doujun': { closedHan: 2, openHan: 1 },
  'Sanshoku Doukou': { closedHan: 2, openHan: 2 },
  'San Ankou': { closedHan: 2, openHan: 2 },
  'San Kantsu': { closedHan: 2, openHan: 2 },
  Toitoi: { closedHan: 2, openHan: 2 },
  Honroutou: { closedHan: 2, openHan: 2 },
  'Shou Sangen': { closedHan: 2, openHan: 2 },
  Honitsu: { closedHan: 3, openHan: 2 },
  Junchan: { closedHan: 3, openHan: 2 },
  Ryanpeikou: { closedHan: 3, openHan: 0 },
  Chinitsu: { closedHan: 6, openHan: 5 },
  Renhou: { closedHan: 5, openHan: 0 },
  'Nagashi Mangan': { closedHan: 5, openHan: 5 },
  Dora: { closedHan: 0, openHan: 0 },
  'Aka Dora': { closedHan: 0, openHan: 0 },
  'Ura Dora': { closedHan: 0, openHan: 0 },
  'Kokushi Musou': { closedHan: 13, openHan: 0, isYakuman: true },
  'Suu Ankou': { closedHan: 13, openHan: 0, isYakuman: true },
  Daisangen: { closedHan: 13, openHan: 13, isYakuman: true },
  Shousuushii: { closedHan: 13, openHan: 13, isYakuman: true },
  Ryuuiisou: { closedHan: 13, openHan: 13, isYakuman: true },
  'Suu Kantsu': { closedHan: 13, openHan: 13, isYakuman: true },
  'Tsuu Iisou': { closedHan: 13, openHan: 13, isYakuman: true },
  Chinroutou: { closedHan: 13, openHan: 13, isYakuman: true },
  'Chuuren Poutou': { closedHan: 13, openHan: 0, isYakuman: true },
  Tenhou: { closedHan: 13, openHan: 0, isYakuman: true },
  Chiihou: { closedHan: 13, openHan: 0, isYakuman: true },
  Daisharin: { closedHan: 13, openHan: 0, isYakuman: true },
  Daichikurin: { closedHan: 13, openHan: 0, isYakuman: true },
  Daisuurin: { closedHan: 13, openHan: 0, isYakuman: true },
  Daichisei: { closedHan: 13, openHan: 0, isYakuman: true },
  Paarenchan: { closedHan: 13, openHan: 13, isYakuman: true },
  'Renhou (yakuman)': { closedHan: 13, openHan: 0, isYakuman: true },
  Sashikomi: { closedHan: 13, openHan: 13, isYakuman: true },
  'Kokushi Musou Juusanmen Matchi': { closedHan: 26, openHan: 0, isYakuman: true },
  'Suu Ankou Tanki': { closedHan: 26, openHan: 0, isYakuman: true },
  'Daburu Chuuren Poutou': { closedHan: 26, openHan: 0, isYakuman: true },
  'Dai Suushii': { closedHan: 26, openHan: 26, isYakuman: true },
}

const RESULT_LEVEL_KEYS: Record<string, string> = {
  mangan: 'result.limit.mangan',
  'kiriage mangan': 'result.limit.mangan',
  'nagashi mangan': 'result.limit.nagashiMangan',
  haneman: 'result.limit.haneman',
  baiman: 'result.limit.baiman',
  sanbaiman: 'result.limit.sanbaiman',
  'kazoe sanbaiman': 'result.limit.kazoeSanbaiman',
  yakuman: 'result.yakuman',
  'kazoe yakuman': 'result.limit.kazoeYakuman',
  '2x yakuman': 'result.limit.doubleYakuman',
  '3x yakuman': 'result.limit.tripleYakuman',
  '4x yakuman': 'result.limit.fourYakuman',
  '5x yakuman': 'result.limit.fiveYakuman',
  '6x yakuman': 'result.limit.sixYakuman',
}

function yakuMeta(name: string): YakuDisplayMeta | undefined {
  if (YAKU_DISPLAY_META[name]) return YAKU_DISPLAY_META[name]
  const countedBonus = name.match(/^(Dora|Aka Dora|Ura Dora)\s+(\d+)$/)
  if (!countedBonus) return undefined
  const base = YAKU_DISPLAY_META[countedBonus[1]]
  const han = Number(countedBonus[2])
  return base ? { ...base, closedHan: han, openHan: han } : undefined
}

function resultBasePoints(han: number, fu: number): number {
  if (han >= 13) return 8000 * Math.max(1, Math.floor(han / 13))
  if (han >= 11) return 6000
  if (han >= 8) return 4000
  if (han >= 6) return 3000
  if (han >= 5) return 2000
  const calculated = fu * (2 ** (han + 2))
  return Math.min(2000, calculated)
}

function ceilToHundred(value: number): number {
  return Math.ceil(value / 100) * 100
}

export function useRoundResultPresentation(options: {
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  t: Translate
  relativeSeatLabel: (seat: number) => string
}) {
  const { gameView, status, t, relativeSeatLabel } = options

  function localizedYakuLabel(name: string, fallback: string): string {
    const baseName = name.replace(/^(Dora|Aka Dora|Ura Dora)\s+\d+$/, '$1')
    const key = `yaku.${baseName}`
    const translated = t(key)
    return translated === key ? fallback : translated
  }

  const resultIsOpenHand = computed(() => {
    const info = gameView.table?.resultInfo
    if (typeof info?.isOpenHand === 'boolean') return info.isOpenHand
    const actor = Number(info?.actor)
    if (!Number.isInteger(actor) || actor < 0 || actor > 3) return false
    return (gameView.table?.melds?.[actor] || []).some((meld) => String(meld.type || '') !== 'ankan')
  })

  const resultYakuItems = computed<ResultYakuItem[]>(() => {
    const info = gameView.table?.resultInfo
    if (!info) return []
    if (info.yakuDetails?.length) {
      return info.yakuDetails.map((item) => ({
        name: item.name,
        label: localizedYakuLabel(item.name, item.name),
        han: Number(item.han || 0),
        isYakuman: Boolean(item.isYakuman),
      }))
    }
    const items = (info.yaku || []).map((name) => {
      const meta = yakuMeta(name)
      return {
        name,
        label: localizedYakuLabel(name, name),
        han: resultIsOpenHand.value ? Number(meta?.openHan || 0) : Number(meta?.closedHan || 0),
        isYakuman: Boolean(meta?.isYakuman),
      }
    })
    const bonusItems = items.filter((item) => ['Dora', 'Aka Dora', 'Ura Dora'].includes(item.name))
    if (bonusItems.length === 1 && bonusItems[0].han === 0) {
      const knownHan = items.reduce((sum, item) => sum + item.han, 0)
      bonusItems[0].han = Math.max(0, Number(info.han || 0) - knownHan)
    }
    return items
  })

  const resultHasHora = computed(() => {
    const actor = Number(gameView.table?.resultInfo?.actor)
    return Number.isInteger(actor) && actor >= 0 && actor <= 3
  })

  const resultIsMatchEnd = computed(() => gameView.table?.resultInfo?.eventType === 'match_end')

  const resultIsRiichiHora = computed(() => {
    const info = gameView.table?.resultInfo
    const actor = Number(info?.actor)
    if (!info || !Number.isInteger(actor) || actor < 0 || actor > 3) return false
    if (info.uraMarkers?.length) return true
    if (gameView.table?.riichiAccepted?.[actor]) return true
    return resultYakuItems.value.some((item) => (
      item.name === 'Riichi'
      || item.name === 'Double Riichi'
      || item.name === 'Open Riichi'
      || item.name === 'Double Open Riichi'
    ))
  })

  const resultDoraSlots = computed(() => {
    const indicators = gameView.table?.doraIndicators || []
    return Array.from({ length: 5 }, (_, index) => indicators[index] || '?')
  })

  const resultUraSlots = computed(() => {
    const info = gameView.table?.resultInfo
    const revealedDoraCount = Math.min(5, gameView.table?.doraIndicators?.length || 0)
    const indicators = info?.uraMarkers?.length ? info.uraMarkers : (gameView.table?.uraIndicators || [])
    return Array.from({ length: 5 }, (_, index) => (
      resultIsRiichiHora.value && index < revealedDoraCount ? indicators[index] || '?' : '?'
    ))
  })

  function formatResultYakuValue(yaku: ResultYakuItem): string {
    if (yaku.isYakuman) {
      const multiplier = Math.max(1, Math.round(yaku.han / 13))
      return multiplier > 1 ? t('result.multipleYakuman', { value: multiplier }) : t('result.yakuman')
    }
    return yaku.han > 0 ? t('result.han', { value: yaku.han }) : ''
  }

  const resultHanFuLabel = computed(() => {
    const info = gameView.table?.resultInfo
    if (!info || (!info.han && !info.fu)) return ''
    return t('result.hanFu', {
      han: Number(info.han || 0),
      fu: info.fu ? t('result.fu', { value: info.fu }) : '',
    })
  })

  const resultPointsLabel = computed(() => {
    const info = gameView.table?.resultInfo
    if (!info) return ''
    const main = Number(info.cost?.main)
    const additional = Number(info.cost?.additional)
    if (Number.isFinite(main) && main > 0) {
      return String(Math.round(main + (Number.isFinite(additional) ? additional * 2 : 0)))
    }
    const actor = Number(info.actor)
    const target = Number(info.target)
    const han = Number(info.han || 0)
    const fu = Number(info.fu || 0)
    if (!Number.isInteger(actor) || actor < 0 || actor > 3 || han <= 0) return ''
    const basePoints = resultBasePoints(han, fu)
    const isDealer = actor === gameView.table?.dealer
    if (actor !== target) return String(ceilToHundred(basePoints * (isDealer ? 6 : 4)))
    const dealerPayment = ceilToHundred(basePoints * 2)
    const nonDealerPayment = ceilToHundred(basePoints)
    return String(isDealer ? dealerPayment * 3 : dealerPayment + nonDealerPayment * 2)
  })

  const resultHandLabel = computed(() => {
    const info = gameView.table?.resultInfo
    if (!info) return ''
    const level = String(info.cost?.yaku_level || '')
    if (level) return RESULT_LEVEL_KEYS[level] ? t(RESULT_LEVEL_KEYS[level]) : level
    const han = Number(info.han || 0)
    const fu = Number(info.fu || 0)
    if (han >= 13) return t('result.limit.kazoeYakuman')
    if (han >= 11) return t('result.limit.sanbaiman')
    if (han >= 8) return t('result.limit.baiman')
    if (han >= 6) return t('result.limit.haneman')
    if (resultBasePoints(han, fu) >= 2000) return t('result.limit.mangan')
    return ''
  })

  const resultScoreLayout = computed(() => {
    const info = gameView.table?.resultInfo
    const controlledSeat = status.controlledSeat
    const positions = [
      { position: 'toimen', offset: 2 },
      { position: 'kamicha', offset: 3 },
      { position: 'shimocha', offset: 1 },
      { position: 'self', offset: 0 },
    ] as const
    return positions.map(({ position, offset }) => {
      const seat = (controlledSeat + offset) % 4
      const after = Number(info?.scores?.[seat] ?? 0)
      const delta = Number(info?.deltas?.[seat] ?? 0)
      return {
        position,
        seat,
        label: relativeSeatLabel(seat),
        rank: Number(info?.ranks?.[seat] ?? seat + 1),
        before: after - delta,
        delta,
        after,
      }
    })
  })

  return {
    formatResultYakuValue,
    resultDoraSlots,
    resultHandLabel,
    resultHanFuLabel,
    resultHasHora,
    resultIsMatchEnd,
    resultPointsLabel,
    resultScoreLayout,
    resultUraSlots,
    resultYakuItems,
  }
}
