import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { GameView } from './contracts/game'
import type { RecordImportResult, StudioStatus } from './contracts/runtime'
import { useI18n } from './i18n'

type GameFileOperation = 'create' | 'open' | 'import' | 'save' | 'save-as' | 'close'

interface UseRecordSessionOptions {
  status: StudioStatus
  gameView: GameView
  flushRecordEdits: () => Promise<void>
  hasRecordDrafts: () => boolean
  applyStatus: (status: StudioStatus) => void
  applyGameView: (view: GameView) => void
  refreshGameView: () => Promise<void>
  prepareClose: () => void
  handleReconstruction: (roundCount: number) => void | Promise<void>
}

const DISCARD_CONFIRMATION_TIMEOUT_MS = 3000
type ReplacementOperation = 'create' | 'open' | 'import' | 'close'

function fileNameFromPath(value: string): string {
  return String(value || '').split(/[\\/]/).pop() || ''
}

export function useRecordSession(options: UseRecordSessionOptions) {
  const { t } = useI18n()
  const {
    status,
    gameView,
    flushRecordEdits,
    hasRecordDrafts,
    applyStatus,
    applyGameView,
    refreshGameView,
    prepareClose,
    handleReconstruction,
  } = options
  const recordPath = ref('')
  const recordDirty = ref(false)
  const recoveryRecord = ref(false)
  const gameFileOperation = ref<GameFileOperation | null>(null)
  const recordOperationError = ref('')
  const discardConfirmation = ref<ReplacementOperation | null>(null)
  const showRecordImportPanel = ref(false)
  let recordDirtyEventGeneration = 0
  let discardConfirmationTimer: number | null = null

  function reportOperationError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    recordOperationError.value = t('recordOperation.failed', { message })
  }

  const recordHeaderTitle = computed(() => (
    recordPath.value ? fileNameFromPath(recordPath.value) : ''
  ))

  function setRecordPath(nextPath: string | null | undefined) {
    recordPath.value = nextPath || ''
  }

  function setRecordDirtySnapshot(dirty: boolean) {
    recordDirty.value = dirty
  }

  function markRecordDirty() {
    recordDirty.value = true
  }

  function handleRecordDirtyChanged(dirty: boolean) {
    recordDirtyEventGeneration += 1
    recordDirty.value = dirty || hasRecordDrafts()
  }

  function restoreRecordMetadata(path: string | null | undefined, isRecoveryRecord: boolean) {
    setRecordPath(path)
    recoveryRecord.value = isRecoveryRecord
  }

  function clearRecordMetadata() {
    setRecordPath('')
    recordDirty.value = false
    recoveryRecord.value = false
  }

  function openRecordImportPanel() {
    if (gameFileOperation.value !== null) return
    if (!confirmReplacement('import')) return
    showRecordImportPanel.value = true
  }

  function closeRecordImportPanel() {
    if (gameFileOperation.value !== null) return
    showRecordImportPanel.value = false
  }

  function handleImportBusy(busy: boolean) {
    if (busy) gameFileOperation.value = 'import'
    else if (gameFileOperation.value === 'import') gameFileOperation.value = null
  }

  async function handleRecordImported(result: RecordImportResult) {
    applyStatus(result.state)
    applyGameView(result.view)
    setRecordPath('')
    recordDirty.value = Boolean(result.recordDirty)
    recoveryRecord.value = false
    showRecordImportPanel.value = false
    if (result.reconstruction) await handleReconstruction(result.reconstruction.roundCount)
  }

  async function createGame() {
    if (!window.studioAPI || gameFileOperation.value !== null) return
    if (!confirmReplacement('create')) return
    gameFileOperation.value = 'create'
    recordOperationError.value = ''
    try {
      await flushRecordEdits()
      applyStatus(await window.studioAPI.createGame())
      setRecordPath('')
      recoveryRecord.value = false
      await refreshGameView()
    } catch (error) {
      reportOperationError(error)
    } finally {
      gameFileOperation.value = null
    }
  }

  async function openGame() {
    if (!window.studioAPI || gameFileOperation.value !== null) return
    if (!confirmReplacement('open')) return
    gameFileOperation.value = 'open'
    recordOperationError.value = ''
    try {
      await flushRecordEdits()
      const result = await window.studioAPI.openGame()
      if (!result) return
      applyStatus(result.state)
      applyGameView(result.view)
      setRecordPath(result.path)
      recordDirty.value = Boolean(result.recordDirty)
      recoveryRecord.value = Boolean(result.recoveryRecord)
    } catch (error) {
      reportOperationError(error)
    } finally {
      gameFileOperation.value = null
    }
  }

  async function saveWith(operation: 'save' | 'save-as') {
    if (!window.studioAPI || gameFileOperation.value !== null) return
    clearDiscardConfirmation()
    if (operation === 'save' && !recordDirty.value) return
    gameFileOperation.value = operation
    recordOperationError.value = ''
    try {
      await flushRecordEdits()
      const dirtyGeneration = recordDirtyEventGeneration
      const gameId = gameView.gameId
      const result = operation === 'save'
        ? await window.studioAPI.saveGame()
        : await window.studioAPI.saveGameAs()
      if (!result || gameId !== gameView.gameId) return
      setRecordPath(result.path)
      if (dirtyGeneration === recordDirtyEventGeneration) {
        recordDirty.value = Boolean(result.recordDirty) || hasRecordDrafts()
      }
      recoveryRecord.value = Boolean(result.recoveryRecord)
    } catch (error) {
      reportOperationError(error)
    } finally {
      gameFileOperation.value = null
    }
  }

  function saveGame() {
    return saveWith('save')
  }

  function saveGameAs() {
    return saveWith('save-as')
  }

  function clearDiscardConfirmation() {
    discardConfirmation.value = null
    if (discardConfirmationTimer !== null) {
      window.clearTimeout(discardConfirmationTimer)
      discardConfirmationTimer = null
    }
  }

  function confirmReplacement(operation: ReplacementOperation): boolean {
    if (!status.gameLoaded || (!recordDirty.value && !hasRecordDrafts()) || discardConfirmation.value === operation) {
      clearDiscardConfirmation()
      return true
    }
    discardConfirmation.value = operation
    if (discardConfirmationTimer !== null) window.clearTimeout(discardConfirmationTimer)
    discardConfirmationTimer = window.setTimeout(() => {
      discardConfirmation.value = null
      discardConfirmationTimer = null
    }, DISCARD_CONFIRMATION_TIMEOUT_MS)
    return false
  }

  async function closeGame() {
    if (!window.studioAPI || !status.gameLoaded || gameFileOperation.value !== null) return
    if (!confirmReplacement('close')) return
    gameFileOperation.value = 'close'
    recordOperationError.value = ''
    try {
      await flushRecordEdits()
      prepareClose()
      const response = await window.studioAPI.closeGame()
      applyStatus(response.state)
      applyGameView(response.view)
      clearRecordMetadata()
    } catch (error) {
      reportOperationError(error)
    } finally {
      gameFileOperation.value = null
    }
  }

  async function showRecordInFolder() {
    if (!recordPath.value || !window.studioAPI) return
    await window.studioAPI.showRecordInFolder()
  }

  watch(recordDirty, (dirty) => {
    if (!dirty) clearDiscardConfirmation()
  })

  watch(() => gameView.gameId, clearDiscardConfirmation)
  onBeforeUnmount(clearDiscardConfirmation)

  return {
    clearRecordMetadata,
    closeGame,
    discardConfirmation,
    closeRecordImportPanel,
    createGame,
    gameFileOperation,
    handleRecordDirtyChanged,
    handleRecordImported,
    handleImportBusy,
    markRecordDirty,
    openGame,
    openRecordImportPanel,
    recordDirty,
    recordHeaderTitle,
    recordPath,
    recordOperationError,
    restoreRecordMetadata,
    saveGame,
    saveGameAs,
    setRecordDirtySnapshot,
    showRecordImportPanel,
    showRecordInFolder,
  }
}
