export type RiichiSettlementValues = {
  nonDealerRon: number
  dealerRon: number
  nonDealerTsumo: number
  dealerTsumo: number
}

export function riichiBasePoints(han: number, fu: number): number {
  if (han >= 13) return 8000 * Math.max(1, Math.floor(han / 13))
  if (han >= 11) return 6000
  if (han >= 8) return 4000
  if (han >= 6) return 3000
  if (han >= 5) return 2000
  return Math.min(2000, fu * (2 ** (han + 2)))
}

export function ceilRiichiPoints(value: number): number {
  return Math.ceil(value / 100) * 100
}

export function riichiSettlementValues(basicPoints: number): RiichiSettlementValues {
  const nonDealerPayment = ceilRiichiPoints(basicPoints)
  const dealerPayment = ceilRiichiPoints(basicPoints * 2)
  return {
    nonDealerRon: ceilRiichiPoints(basicPoints * 4),
    dealerRon: ceilRiichiPoints(basicPoints * 6),
    nonDealerTsumo: dealerPayment + (nonDealerPayment * 2),
    dealerTsumo: dealerPayment * 3,
  }
}

function regularHandValues(dealer: boolean): ReadonlySet<number> {
  const values = new Set<number>()
  const add = (basicPoints: number) => {
    const settlement = riichiSettlementValues(basicPoints)
    values.add(dealer ? settlement.dealerRon : settlement.nonDealerRon)
    values.add(dealer ? settlement.dealerTsumo : settlement.nonDealerTsumo)
  }
  const fuValues = [20, 25, ...Array.from({ length: 9 }, (_, index) => 30 + (index * 10))]
  for (let han = 1; han <= 4; han += 1) {
    for (const fu of fuValues) {
      if (han === 1 && (fu === 20 || fu === 25)) continue
      add(riichiBasePoints(han, fu))
    }
  }
  for (const basicPoints of [2000, 3000, 4000, 6000]) add(basicPoints)
  return values
}

const NON_DEALER_HAND_VALUES = regularHandValues(false)
const DEALER_HAND_VALUES = regularHandValues(true)

export function isPossibleRiichiHandValue(value: number, dealer: boolean): boolean {
  if (!Number.isInteger(value) || value <= 0) return false
  const regularValues = dealer ? DEALER_HAND_VALUES : NON_DEALER_HAND_VALUES
  if (regularValues.has(value)) return true
  const yakumanValue = dealer ? 48000 : 32000
  return value >= yakumanValue && value % yakumanValue === 0
}
