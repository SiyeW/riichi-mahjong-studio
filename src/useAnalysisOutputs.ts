import { computed } from 'vue'
import { parseNumericPrediction } from './numericPrediction.ts'

export type AnalysisRecord = Record<string, unknown>

export function analysisRecord(value: unknown): AnalysisRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnalysisRecord : {}
}

export function useAnalysisOutputs(readAnalysis: () => AnalysisRecord | null | undefined) {
  const outputs = computed(() => analysisRecord(readAnalysis()?.outputs))
  const playerLists = computed(() => new Map(Object.entries(outputs.value).map(([id, output]) => {
    const players = analysisRecord(output).players
    return [id, Array.isArray(players) ? players.map(analysisRecord) : []] as const
  })))
  const playerIndexes = computed(() => new Map([...playerLists.value].map(([id, players]) => {
    const index = new Map<number, AnalysisRecord>()
    for (const player of players) {
      const seat = Number(player.seat)
      // Match the first player, as the former Array.find lookup did.
      if (!index.has(seat)) index.set(seat, player)
    }
    return [id, index] as const
  })))

  function outputData(id: string): AnalysisRecord {
    return analysisRecord(outputs.value[id])
  }

  function outputPlayers(id: string): AnalysisRecord[] {
    return playerLists.value.get(id) || []
  }

  function playerOutput(id: string, seat: number): AnalysisRecord {
    return playerIndexes.value.get(id)?.get(seat) || {}
  }

  function seatPrediction(id: string, seat: number) {
    return parseNumericPrediction(playerOutput(id, seat).prediction)
  }

  return { outputData, outputPlayers, playerOutput, seatPrediction }
}
