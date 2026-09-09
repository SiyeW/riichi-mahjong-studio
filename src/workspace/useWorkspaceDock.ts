import { computed, nextTick, onScopeDispose, ref, type Ref } from 'vue'
import { normalizeDockPanelFraction, normalizeDockPanelSizeFractions } from './settings.ts'
import { moveDockItem, moveDockItemBesideNode, resizeDockSplit, visibleDockLayout } from './layout.ts'
import { WORKSPACE_ITEM_IDS, type DockDirection, type DockEdge, type DockPanelId, type DockPanelSizeFractions, type DockResizeRequest, type WorkspaceDockNode, type WorkspaceItemId, type WorkspaceLayoutSettings } from '../contracts/workspace.ts'

type DockDropTarget = {
  edge: DockEdge
  bounds: { left: number; top: number; width: number; height: number }
} & (
  | { kind: 'item'; item: WorkspaceItemId }
  | { kind: 'group'; sourcePath: number[] }
)

interface WorkspaceDockOptions {
  workspaceLayout: Readonly<Ref<WorkspaceLayoutSettings>>
  visiblePanels: Readonly<Ref<readonly DockPanelId[]>>
  uiScale: Readonly<Ref<number>>
  applyWorkspaceLayoutLocally: (layout: WorkspaceLayoutSettings) => unknown
  updateWorkspaceLayout: (layout: WorkspaceLayoutSettings) => void
  invalidateLayoutSave: () => void
}

export interface DockResizeDragState {
  pointerId: number
  direction: DockDirection
  sourcePath: number[]
  beforeIndex: number
  afterIndex: number
  startCoordinate: number
  beforeSize: number
  afterSize: number
  minBeforeSize: number
  minAfterSize: number
  initialLayout: WorkspaceDockNode
}

export function useWorkspaceDock({
  workspaceLayout, visiblePanels, uiScale,
  applyWorkspaceLayoutLocally, updateWorkspaceLayout, invalidateLayoutSave,
}: WorkspaceDockOptions) {
  const pointerEventTarget = typeof window === 'undefined' ? null : window
  const draggingDockPanel = ref<DockPanelId | null>(null)

  function visibleWorkspaceItemIds(excludedPanel: DockPanelId | null = null): Set<WorkspaceItemId> {
    const visibleItems = new Set<WorkspaceItemId>(['table'])
    for (const panel of visiblePanels.value) {
      if (panel !== excludedPanel) visibleItems.add(panel)
    }
    return visibleItems
  }

  const visibleWorkspaceLayout = computed(() => {
    const visibleItems = visibleWorkspaceItemIds(draggingDockPanel.value)
    return visibleDockLayout(workspaceLayout.value.layout, visibleItems)
      || { type: 'item' as const, id: 'table' as const }
  })

  const workspaceRoot = ref<HTMLElement | null>(null)
  const activeDockDropTarget = ref<DockDropTarget | null>(null)
  let dockDragPointerId: number | null = null
  let dockDragPanelSizeFractions: DockPanelSizeFractions | null = null
  let dockPanelPointerCandidate: {
    panel: DockPanelId
    startX: number
    startY: number
  } | null = null


  const dockResizeDrag = ref<DockResizeDragState | null>(null)

  function dockResizeMinimum(items: readonly WorkspaceItemId[], direction: DockDirection): number {
    const scale = uiScale.value
    if (direction === 'horizontal') {
      if (items.includes('table')) return 360 * scale
      if (items.includes('console')) return 230 * scale
      return 250 * scale
    }
    if (items.includes('table')) return 260 * scale
    return 96 * scale
  }

  function normalizedDockResizeMinimums(
    pairSize: number,
    beforeMinimum: number,
    afterMinimum: number,
  ): [number, number] {
    const usableSize = Math.max(2, pairSize - 2)
    const requestedSize = beforeMinimum + afterMinimum
    if (requestedSize <= usableSize) return [beforeMinimum, afterMinimum]
    const scale = usableSize / Math.max(1, requestedSize)
    return [beforeMinimum * scale, afterMinimum * scale]
  }

  function handleDockResizePointerMove(event: PointerEvent) {
    const drag = dockResizeDrag.value
    if (!drag || event.pointerId !== drag.pointerId) return
    const coordinate = drag.direction === 'horizontal' ? event.clientX : event.clientY
    const pairSize = drag.beforeSize + drag.afterSize
    const desiredBeforeSize = Math.max(
      drag.minBeforeSize,
      Math.min(pairSize - drag.minAfterSize, drag.beforeSize + coordinate - drag.startCoordinate),
    )
    const layout = resizeDockSplit(
      drag.initialLayout,
      drag.sourcePath,
      drag.beforeIndex,
      drag.afterIndex,
      desiredBeforeSize / Math.max(1, pairSize),
    )
    applyWorkspaceLayoutLocally({ ...workspaceLayout.value, layout })
  }

  function removeDockResizePointerListeners() {
    pointerEventTarget?.removeEventListener('pointermove', handleDockResizePointerMove)
    pointerEventTarget?.removeEventListener('pointerup', finishDockResize)
    pointerEventTarget?.removeEventListener('pointercancel', cancelDockResize)
    pointerEventTarget?.removeEventListener('keydown', handleDockResizeKeydown)
  }

  function finishDockResize(event: PointerEvent) {
    const drag = dockResizeDrag.value
    if (!drag || event.pointerId !== drag.pointerId) return
    const finalLayout = workspaceLayout.value
    removeDockResizePointerListeners()
    dockResizeDrag.value = null
    updateWorkspaceLayout(finalLayout)
  }

  function cancelDockResize(event?: PointerEvent) {
    const drag = dockResizeDrag.value
    if (!drag || (event && event.pointerId !== drag.pointerId)) return
    removeDockResizePointerListeners()
    dockResizeDrag.value = null
    applyWorkspaceLayoutLocally({ ...workspaceLayout.value, layout: drag.initialLayout })
  }

  function handleDockResizeKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    cancelDockResize()
  }

  function startDockResize(request: DockResizeRequest) {
    if (request.event.button !== 0) return
    if (draggingDockPanel.value) {
      removeDockPanelPointerListeners()
      endDockPanelDrag()
    }
    if (dockResizeDrag.value) cancelDockResize()
    invalidateLayoutSave()
    const pairSize = request.beforeSize + request.afterSize
    const [minBeforeSize, minAfterSize] = normalizedDockResizeMinimums(
      pairSize,
      dockResizeMinimum(request.beforeItems, request.direction),
      dockResizeMinimum(request.afterItems, request.direction),
    )
    dockResizeDrag.value = {
      pointerId: request.event.pointerId,
      direction: request.direction,
      sourcePath: [...request.sourcePath],
      beforeIndex: request.beforeIndex,
      afterIndex: request.afterIndex,
      startCoordinate: request.direction === 'horizontal' ? request.event.clientX : request.event.clientY,
      beforeSize: request.beforeSize,
      afterSize: request.afterSize,
      minBeforeSize,
      minAfterSize,
      initialLayout: workspaceLayout.value.layout,
    }
    pointerEventTarget?.addEventListener('pointermove', handleDockResizePointerMove)
    pointerEventTarget?.addEventListener('pointerup', finishDockResize)
    pointerEventTarget?.addEventListener('pointercancel', cancelDockResize)
    pointerEventTarget?.addEventListener('keydown', handleDockResizeKeydown)
  }

  function dockDropTargetAt(clientX: number, clientY: number): DockDropTarget | null {
    const dragging = draggingDockPanel.value
    if (!dragging) return null
    const leaf = document.elementsFromPoint(clientX, clientY).flatMap((element) => {
      const candidate = element.closest<HTMLElement>('.dock-layout-leaf[data-dock-target]')
      return candidate ? [candidate] : []
    })[0]
    if (!leaf) return null
    const groupEdgeBand = Math.max(10, Math.round(12 * uiScale.value))
    let group = leaf.parentElement?.closest<HTMLElement>('.dock-layout-split[data-dock-path]') || null
    while (group) {
      const rect = group.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const groupDistances: Array<{ edge: DockEdge; distance: number }> = [
          { edge: 'left', distance: Math.abs(clientX - rect.left) },
          { edge: 'right', distance: Math.abs(rect.right - clientX) },
          { edge: 'top', distance: Math.abs(clientY - rect.top) },
          { edge: 'bottom', distance: Math.abs(rect.bottom - clientY) },
        ]
        groupDistances.sort((left, right) => left.distance - right.distance)
        if (groupDistances[0].distance <= groupEdgeBand) {
          const sourcePath = group.dataset.dockPath === ''
            ? []
            : String(group.dataset.dockPath).split('.').map(Number)
          if (sourcePath.every((index) => Number.isInteger(index) && index >= 0)) {
            return {
              kind: 'group',
              sourcePath,
              edge: groupDistances[0].edge,
              bounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            }
          }
        }
      }
      group = group.parentElement?.closest<HTMLElement>('.dock-layout-split[data-dock-path]') || null
    }
    const itemId = leaf.dataset.dockTarget
    if (!itemId || itemId === dragging || !WORKSPACE_ITEM_IDS.includes(itemId as WorkspaceItemId)) return null
    const rect = leaf.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const distances: Array<{ edge: DockEdge; distance: number }> = [
      { edge: 'left', distance: Math.abs(clientX - rect.left) / rect.width },
      { edge: 'right', distance: Math.abs(rect.right - clientX) / rect.width },
      { edge: 'top', distance: Math.abs(clientY - rect.top) / rect.height },
      { edge: 'bottom', distance: Math.abs(rect.bottom - clientY) / rect.height },
    ]
    distances.sort((left, right) => left.distance - right.distance)
    return {
      kind: 'item',
      item: itemId as WorkspaceItemId,
      edge: distances[0].edge,
      bounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    }
  }

  function handleDockPanelPointerMove(event: PointerEvent) {
    if (event.pointerId !== dockDragPointerId || !dockPanelPointerCandidate) return
    if (!draggingDockPanel.value) {
      const distance = Math.hypot(
        event.clientX - dockPanelPointerCandidate.startX,
        event.clientY - dockPanelPointerCandidate.startY,
      )
      const threshold = Math.max(4, Math.round(4 * uiScale.value))
      if (distance < threshold) return
      const panel = dockPanelPointerCandidate.panel
      dockDragPanelSizeFractions = captureDockPanelSizeFractions(panel)
      draggingDockPanel.value = panel
      activeDockDropTarget.value = null
      void nextTick(() => {
        if (event.pointerId !== dockDragPointerId || draggingDockPanel.value !== panel) return
        activeDockDropTarget.value = dockDropTargetAt(event.clientX, event.clientY)
      })
      return
    }
    activeDockDropTarget.value = dockDropTargetAt(event.clientX, event.clientY)
  }

  function finishDockPanelPointerDrag(event: PointerEvent) {
    if (event.pointerId !== dockDragPointerId) return
    const wasDragging = Boolean(draggingDockPanel.value)
    const target = activeDockDropTarget.value
    removeDockPanelPointerListeners()
    if (wasDragging && target) dropDockPanel(target)
    else endDockPanelDrag()
  }

  function cancelDockPanelPointerDrag(event: PointerEvent) {
    if (event.pointerId !== dockDragPointerId) return
    removeDockPanelPointerListeners()
    endDockPanelDrag()
  }

  function removeDockPanelPointerListeners() {
    pointerEventTarget?.removeEventListener('pointermove', handleDockPanelPointerMove)
    pointerEventTarget?.removeEventListener('pointerup', finishDockPanelPointerDrag)
    pointerEventTarget?.removeEventListener('pointercancel', cancelDockPanelPointerDrag)
    pointerEventTarget?.removeEventListener('keydown', handleDockPanelDragKeydown)
    dockDragPointerId = null
    dockPanelPointerCandidate = null
  }

  function handleDockPanelDragKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || dockDragPointerId === null) return
    removeDockPanelPointerListeners()
    endDockPanelDrag()
  }

  function measureDockPanelFraction(panel: DockPanelId): {
    direction: DockDirection
    fraction: number
  } | null {
    const leaf = document.querySelector<HTMLElement>(`.dock-layout-leaf[data-dock-target="${panel}"]`)
    const tableLeaf = document.querySelector<HTMLElement>('.dock-layout-leaf[data-dock-target="table"]')
    if (!leaf || !tableLeaf) return null
    let split = leaf.parentElement?.closest<HTMLElement>('.dock-layout-split') || null
    while (split && !split.contains(tableLeaf)) {
      split = split.parentElement?.closest<HTMLElement>('.dock-layout-split') || null
    }
    if (!split) return null
    const direction: DockDirection = split.classList.contains('is-horizontal')
      ? 'horizontal'
      : 'vertical'
    let branch: HTMLElement | null = leaf
    while (branch && branch.parentElement !== split) branch = branch.parentElement
    if (!branch?.classList.contains('dock-layout-child')) return null
    const siblings = [...split.children].filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.classList.contains('dock-layout-child')
    ))
    const size = direction === 'horizontal'
      ? branch.getBoundingClientRect().width
      : branch.getBoundingClientRect().height
    const totalSize = siblings.reduce((total, sibling) => {
      const bounds = sibling.getBoundingClientRect()
      return total + (direction === 'horizontal' ? bounds.width : bounds.height)
    }, 0)
    const fraction = normalizeDockPanelFraction(size / Math.max(1, totalSize))
    return fraction === null ? null : { direction, fraction }
  }

  function captureDockPanelSizeFractions(panel: DockPanelId): DockPanelSizeFractions {
    const captured = normalizeDockPanelSizeFractions(workspaceLayout.value.panelSizeFractions)
    const panelFractions = { ...captured[panel] }
    const measured = measureDockPanelFraction(panel)
    if (measured) panelFractions[measured.direction] = measured.fraction
    if (Object.keys(panelFractions).length) captured[panel] = panelFractions
    return captured
  }

  function defaultDockPanelFraction(direction: DockDirection): number {
    return direction === 'horizontal' ? 0.24 : 0.32
  }

  function startDockPanelPointerDrag(panel: DockPanelId, event: PointerEvent) {
    if (event.button !== 0) return
    if (dockResizeDrag.value) cancelDockResize()
    if (dockDragPointerId !== null) {
      removeDockPanelPointerListeners()
      endDockPanelDrag()
    }
    event.preventDefault()
    dockDragPointerId = event.pointerId
    dockPanelPointerCandidate = {
      panel,
      startX: event.clientX,
      startY: event.clientY,
    }
    dockDragPanelSizeFractions = null
    activeDockDropTarget.value = null
    pointerEventTarget?.addEventListener('pointermove', handleDockPanelPointerMove)
    pointerEventTarget?.addEventListener('pointerup', finishDockPanelPointerDrag)
    pointerEventTarget?.addEventListener('pointercancel', cancelDockPanelPointerDrag)
    pointerEventTarget?.addEventListener('keydown', handleDockPanelDragKeydown)
  }

  function endDockPanelDrag() {
    draggingDockPanel.value = null
    activeDockDropTarget.value = null
    dockDragPanelSizeFractions = null
    dockPanelPointerCandidate = null
  }

  function dropDockPanel(target: DockDropTarget) {
    const panel = draggingDockPanel.value
    if (!panel) return
    const direction: DockDirection = target.edge === 'left' || target.edge === 'right'
      ? 'horizontal'
      : 'vertical'
    const panelSizeFractions = normalizeDockPanelSizeFractions(
      dockDragPanelSizeFractions ?? workspaceLayout.value.panelSizeFractions,
    )
    const insertedFraction = panelSizeFractions[panel]?.[direction]
      ?? defaultDockPanelFraction(direction)
    const visibleItems = visibleWorkspaceItemIds(panel)
    panelSizeFractions[panel] = {
      ...panelSizeFractions[panel],
      [direction]: insertedFraction,
    }
    const layout = target.kind === 'group'
      ? moveDockItemBesideNode(
          workspaceLayout.value.layout,
          panel,
          target.sourcePath,
          target.edge,
          insertedFraction,
          visibleItems,
        )
      : moveDockItem(
          workspaceLayout.value.layout,
          panel,
          target.item,
          target.edge,
          insertedFraction,
          visibleItems,
        )
    updateWorkspaceLayout({ ...workspaceLayout.value, layout, panelSizeFractions })
    endDockPanelDrag()
  }

  const dockDropIndicatorStyle = computed(() => {
    const target = activeDockDropTarget.value
    const rootBounds = workspaceRoot.value?.getBoundingClientRect()
    if (!target || !rootBounds) return {}
    const thickness = Math.max(3, Math.round(3 * uiScale.value))
    const left = target.bounds.left - rootBounds.left
    const top = target.bounds.top - rootBounds.top
    if (target.edge === 'left' || target.edge === 'right') {
      const rawBoundary = target.bounds.left + (target.edge === 'right' ? target.bounds.width : 0)
      const matchingResizer = [...document.querySelectorAll<HTMLElement>('.dock-layout-resizer.is-horizontal')]
        .map((element) => element.getBoundingClientRect())
        .filter((bounds) => (
          Math.abs(bounds.left + (bounds.width / 2) - rawBoundary) <= Math.max(2, thickness)
          && bounds.bottom > target.bounds.top
          && bounds.top < target.bounds.top + target.bounds.height
        ))
        .sort((first, second) => (
          Math.abs(first.left + (first.width / 2) - rawBoundary)
          - Math.abs(second.left + (second.width / 2) - rawBoundary)
        ))[0]
      const boundary = matchingResizer
        ? matchingResizer.left + (matchingResizer.width / 2)
        : rawBoundary
      return {
        left: `${boundary - rootBounds.left - (thickness / 2)}px`,
        top: `${top}px`,
        width: `${thickness}px`,
        height: `${target.bounds.height}px`,
      }
    }
    const rawBoundary = target.bounds.top + (target.edge === 'bottom' ? target.bounds.height : 0)
    const matchingResizer = [...document.querySelectorAll<HTMLElement>('.dock-layout-resizer.is-vertical')]
      .map((element) => element.getBoundingClientRect())
      .filter((bounds) => (
        Math.abs(bounds.top + (bounds.height / 2) - rawBoundary) <= Math.max(2, thickness)
        && bounds.right > target.bounds.left
        && bounds.left < target.bounds.left + target.bounds.width
      ))
      .sort((first, second) => (
        Math.abs(first.top + (first.height / 2) - rawBoundary)
        - Math.abs(second.top + (second.height / 2) - rawBoundary)
      ))[0]
    const boundary = matchingResizer
      ? matchingResizer.top + (matchingResizer.height / 2)
      : rawBoundary
    return {
      left: `${left}px`,
      top: `${boundary - rootBounds.top - (thickness / 2)}px`,
      width: `${target.bounds.width}px`,
      height: `${thickness}px`,
    }
  })

  onScopeDispose(() => {
    removeDockPanelPointerListeners()
    removeDockResizePointerListeners()
  })

  return {
    draggingDockPanel, visibleWorkspaceLayout, workspaceRoot, activeDockDropTarget,
    dockResizeDrag, startDockResize, startDockPanelPointerDrag, dockDropIndicatorStyle,
  }
}
