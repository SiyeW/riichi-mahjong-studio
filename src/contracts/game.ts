export interface GameAction {
  id: string
  candidateId?: string
  type: string
  actor: number
  pai?: string
  variant?: string
  reasonLabel?: string
  consumed?: string[]
  label: string
  value?: number
  probability?: number
  bar?: number
  tsumogiri?: boolean
}
