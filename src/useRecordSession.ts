import { computed, onBeforeUnmount, ref, watch } from 'vue'
type GameFileOperation = 'create' | 'open' | 'save' | 'save-as' | 'close'

interface UseRecordSessionOptions {
  status: TrainerStatusSnapshot
  gameView: TrainerGameView
  flushNodeComment: () => Promise<void>
  hasNodeCommentDrafts: () => boolean
  applyStatus: (status: TrainerStatusSnapshot) => void
  applyGameView: (view: TrainerGameView) => void
  refreshGameView: () => Promise<void>
  prepareClose: () => void
  handleReconstruction: (roundCount: number) => void | Promise<void>
}

const CLOSE_CONFIRMATION_TIMEOUT_MS = 3000

function fileNameFromPath(value: string): string {
  return String(value || '').split(/[\\/]/).pop() || ''
}

export function useRecordSession(options: UseRecordSessionOptions) {
  const {
    status,
    gameView,
    flushNodeComment,
    hasNodeCommentDrafts,
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
  const closeRecordConfirmationPending = ref(false)
  const showRecordImportPanel = ref(false)
  let recordDirtyEventGeneration = 0
  let closeRecordConfirmationTimer: number | null = null

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
    recordDirty.value = dirty || hasNodeCommentDrafts()
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
    showRecordImportPanel.value = true
  }

  function closeRecordImportPanel() {
    showRecordImportPanel.value = false
  }

  async function handleRecordImported(result: TrainerRecordImportResult) {
    applyStatus(result.state)
    applyGameView(result.view)
    setRecordPath('')
    recordDirty.value = Boolean(result.recordDirty)
    recoveryRecord.value = false
    showRecordImportPanel.value = false
    if (result.reconstruction) await handleReconstruction(result.reconstruction.roundCount)
  }

  async function createGame() {
    if (!window.trainerAPI || gameFileOperation.value !== null) return
    clearCloseRecordConfirmation()
    gameFileOperation.value = 'create'
    try {
      await flushNodeComment()
      applyStatus(await window.trainerAPI.createGame())
      setRecordPath('')
      recoveryRecord.value = false
      await refreshGameView()
    } finally {
      gameFileOperation.value = null
    }
  }

  async function openGame() {
    if (!window.trainerAPI || gameFileOperation.value !== null) return
    clearCloseRecordConfirmation()
    gameFileOperation.value = 'open'
    try {
      await flushNodeComment()
      const result = await window.trainerAPI.openGame()
      if (!result) return
      applyStatus(result.state)
      applyGameView(result.view)
      setRecordPath(result.path)
      recordDirty.value = Boolean(result.recordDirty)
      recoveryRecord.value = Boolean(result.recoveryRecord)
    } finally {
      gameFileOperation.value = null
    }
  }

  async function saveWith(operation: 'save' | 'save-as') {
    if (!window.trainerAPI || gameFileOperation.value !== null) return
    if (operation === 'save' && !recordDirty.value) return
    gameFileOperation.value = operation
    try {
      await flushNodeComment()
      const dirtyGeneration = recordDirtyEventGeneration
      const gameId = gameView.gameId
      const result = operation === 'save'
        ? await window.trainerAPI.saveGame()
        : await window.trainerAPI.saveGameAs()
      if (!result || gameId !== gameView.gameId) return
      setRecordPath(result.path)
      if (dirtyGeneration === recordDirtyEventGeneration) {
        recordDirty.value = Boolean(result.recordDirty) || hasNodeCommentDrafts()
      }
      recoveryRecord.value = Boolean(result.recoveryRecord)
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

  function clearCloseRecordConfirmation() {
    closeRecordConfirmationPending.value = false
    if (closeRecordConfirmationTimer !== null) {
      window.clearTimeout(closeRecordConfirmationTimer)
      closeRecordConfirmationTimer = null
    }
  }

  function requestCloseRecordConfirmation() {
    closeRecordConfirmationPending.value = true
    if (closeRecordConfirmationTimer !== null) window.clearTimeout(closeRecordConfirmationTimer)
    closeRecordConfirmationTimer = window.setTimeout(() => {
      closeRecordConfirmationPending.value = false
      closeRecordConfirmationTimer = null
    }, CLOSE_CONFIRMATION_TIMEOUT_MS)
  }

  async function closeGame() {
    if (!window.trainerAPI || !status.gameLoaded || gameFileOperation.value !== null) return
    if (recordDirty.value && !closeRecordConfirmationPending.value) {
      requestCloseRecordConfirmation()
      return
    }
    clearCloseRecordConfirmation()
    gameFileOperation.value = 'close'
    try {
      await flushNodeComment()
      prepareClose()
      const response = await window.trainerAPI.closeGame()
      applyStatus(response.state)
      applyGameView(response.view)
      clearRecordMetadata()
    } finally {
      gameFileOperation.value = null
    }
  }

  async function showRecordInFolder() {
    if (!recordPath.value || !window.trainerAPI) return
    await window.trainerAPI.showRecordInFolder()
  }

  watch(recordDirty, (dirty) => {
    if (!dirty) clearCloseRecordConfirmation()
  })

  onBeforeUnmount(clearCloseRecordConfirmation)

  return {
    clearRecordMetadata,
    closeGame,
    closeRecordConfirmationPending,
    closeRecordImportPanel,
    createGame,
    gameFileOperation,
    handleRecordDirtyChanged,
    handleRecordImported,
    markRecordDirty,
    openGame,
    openRecordImportPanel,
    recordDirty,
    recordHeaderTitle,
    recordPath,
    restoreRecordMetadata,
    saveGame,
    saveGameAs,
    setRecordDirtySnapshot,
    showRecordImportPanel,
    showRecordInFolder,
  }
}
