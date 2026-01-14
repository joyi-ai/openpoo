import { For, Show, createMemo, createSignal, createEffect, untrack, onCleanup, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { useMultiPane, type PaneConfig } from "@/context/multi-pane"
import { useRadialDial } from "@/hooks/use-radial-dial"
import { RadialDialMenu } from "@opencode-ai/ui/radial-dial-menu"

const FLIP_DURATION = 200
const GRID_GAP = 0
const CORNER_HIT_SIZE = 10
const MIN_PANE_WIDTH = 240
const MIN_PANE_HEIGHT = 180
const MIN_TRACK_SLACK = 0.1

type PaneGridProps = ParentProps<{
  panes: PaneConfig[]
  renderPane: (pane: PaneConfig) => any
}>

export function PaneGrid(props: PaneGridProps) {
  const multiPane = useMultiPane()
  let containerRef: HTMLDivElement | undefined
  let overlayRef: HTMLDivElement | undefined
  let pendingFrame: number | undefined
  const paneRefs = new Map<string, HTMLDivElement>()
  const paneBodyRefs = new Map<string, HTMLDivElement>()
  const paneAnimations = new Map<string, Animation>()
  const maximizeAnimations = new Map<string, Animation>()
  const scrollLocks = new Map<string, () => void>()
  let previousRects = new Map<string, DOMRect>()
  let disposed = false
  let resizeCleanup: (() => void) | null = null

  const layout = createMemo(() => multiPane.layout())
  const maximizedPaneId = createMemo(() => multiPane.maximizedPaneId())
  const [paneIds, setPaneIds] = createSignal<string[]>([])
  const [lastPage, setLastPage] = createSignal(multiPane.currentPage())

  // Radial dial for the entire grid area
  const radialDial = useRadialDial({
    onAction: (action) => {
      const focusedId = multiPane.focusedPaneId()
      const focusedPane = multiPane.focusedPane()
      switch (action) {
        case "new":
          multiPane.addPaneFromFocused()
          break
        case "close":
          if (focusedId) multiPane.removePane(focusedId)
          break
        case "clone":
          if (focusedId) {
            void multiPane.clonePane(focusedId)
          }
          break
        case "expand":
          if (focusedId) {
            multiPane.toggleMaximize(focusedId)
          }
          break
      }
    },
  })

  onCleanup(() => {
    disposed = true
    resizeCleanup?.()
    if (pendingFrame) cancelAnimationFrame(pendingFrame)
    for (const anim of paneAnimations.values()) anim.cancel()
    for (const anim of maximizeAnimations.values()) anim.cancel()
    for (const release of scrollLocks.values()) release()
    scrollLocks.clear()
    paneRefs.clear()
    paneBodyRefs.clear()
    paneAnimations.clear()
    maximizeAnimations.clear()
    previousRects.clear()
  })

  type ScrollSnapshot = {
    el: HTMLElement
    top: number
    left: number
    anchor: string
  }

  function snapshotScroll(root: HTMLElement) {
    const scrollables = root.querySelectorAll<HTMLElement>(".overflow-y-auto, .overflow-auto, [style*='overflow']")
    return Array.from(scrollables).map((el) => ({
      el,
      top: el.scrollTop,
      left: el.scrollLeft,
      anchor: el.style.overflowAnchor,
    }))
  }

  function restoreScroll(items: ScrollSnapshot[]) {
    for (const item of items) {
      item.el.scrollTop = item.top
      item.el.scrollLeft = item.left
    }
  }

  function lockScroll(items: ScrollSnapshot[]) {
    if (items.length === 0) return () => {}

    for (const item of items) {
      item.el.style.overflowAnchor = "none"
    }

    const state = { frame: undefined as number | undefined, active: true }
    const tick = () => {
      if (!state.active) return
      restoreScroll(items)
      state.frame = requestAnimationFrame(tick)
    }
    state.frame = requestAnimationFrame(tick)

    return () => {
      state.active = false
      if (state.frame !== undefined) cancelAnimationFrame(state.frame)
      for (const item of items) {
        item.el.style.overflowAnchor = item.anchor
      }
      restoreScroll(items)
    }
  }

  function releaseScrollLock(id: string) {
    const release = scrollLocks.get(id)
    if (!release) return
    scrollLocks.delete(id)
    release()
  }

  function restorePaneBody(id: string) {
    const maxId = maximizedPaneId()
    if (maxId && id === maxId) return
    const body = paneBodyRefs.get(id)
    if (!body) return
    const slot = paneRefs.get(id)
    if (slot && body.parentElement !== slot) {
      // Save scroll positions before DOM move
      const scrollPositions = snapshotScroll(body)

      slot.appendChild(body)

      // Restore scroll positions after DOM move
      restoreScroll(scrollPositions)
    }
    body.style.position = ""
    body.style.left = ""
    body.style.top = ""
    body.style.width = ""
    body.style.height = ""
    body.style.pointerEvents = ""
  }

  // Capture current positions of all panes
  function capturePositions(): Map<string, DOMRect> {
    const rects = new Map<string, DOMRect>()
    for (const [id, el] of paneRefs) {
      rects.set(id, el.getBoundingClientRect())
    }
    return rects
  }

  function pruneOverlay(currentIdSet: Set<string>) {
    if (!overlayRef) return
    for (const child of Array.from(overlayRef.children)) {
      const el = child as HTMLDivElement
      const id = el.dataset.paneId
      if (!id) {
        el.remove()
        continue
      }
      const body = paneBodyRefs.get(id)
      if (!currentIdSet.has(id) || body !== el) {
        el.remove()
      }
    }
  }

  function animateMaximizedPane(id: string, direction: "expand" | "collapse") {
    if (!containerRef) return
    if (!overlayRef) return
    const body = paneBodyRefs.get(id)
    const slot = paneRefs.get(id)
    if (!body || !slot) return

    releaseScrollLock(id)

    const containerRect = containerRef.getBoundingClientRect()
    const slotRect = slot.getBoundingClientRect()
    const slotLeft = slotRect.left - containerRect.left
    const slotTop = slotRect.top - containerRect.top
    const fullLeft = 0
    const fullTop = 0
    const fullWidth = containerRect.width
    const fullHeight = containerRect.height

    const from =
      direction === "expand"
        ? { left: slotLeft, top: slotTop, width: slotRect.width, height: slotRect.height }
        : { left: fullLeft, top: fullTop, width: fullWidth, height: fullHeight }
    const to =
      direction === "expand"
        ? { left: fullLeft, top: fullTop, width: fullWidth, height: fullHeight }
        : { left: slotLeft, top: slotTop, width: slotRect.width, height: slotRect.height }

    maximizeAnimations.get(id)?.cancel()
    maximizeAnimations.delete(id)
    paneAnimations.get(id)?.cancel()
    paneAnimations.delete(id)

    // Save scroll positions before DOM move
    const scrollPositions = snapshotScroll(body)
    const releaseLock = lockScroll(scrollPositions)
    scrollLocks.set(id, releaseLock)

    overlayRef.appendChild(body)

    // Restore scroll positions after DOM move
    restoreScroll(scrollPositions)
    body.style.position = "absolute"
    body.style.left = `${from.left}px`
    body.style.top = `${from.top}px`
    body.style.width = `${from.width}px`
    body.style.height = `${from.height}px`
    body.style.pointerEvents = "auto"
    body.style.contain = "layout"

    const anim = body.animate(
      [
        {
          left: `${from.left}px`,
          top: `${from.top}px`,
          width: `${from.width}px`,
          height: `${from.height}px`,
        },
        {
          left: `${to.left}px`,
          top: `${to.top}px`,
          width: `${to.width}px`,
          height: `${to.height}px`,
        },
      ],
      { duration: FLIP_DURATION, easing: "ease-out" },
    )
    maximizeAnimations.set(id, anim)
    anim.finished.then(
      () => {
        releaseScrollLock(id)
        if (disposed) return
        if (maximizeAnimations.get(id) !== anim) return
        maximizeAnimations.delete(id)
        body.style.contain = ""
        if (direction === "collapse") {
          restorePaneBody(id)
          return
        }
        body.style.left = `${to.left}px`
        body.style.top = `${to.top}px`
        body.style.width = `${to.width}px`
        body.style.height = `${to.height}px`
      },
      () => {
        releaseScrollLock(id)
        body.style.contain = ""
      },
    )
  }

  const [lastMaximized, setLastMaximized] = createSignal<string | null>(null)

  createEffect(() => {
    const nextMax = maximizedPaneId()
    const prevMax = untrack(() => lastMaximized())
    if (nextMax === prevMax) return

    untrack(() => setLastMaximized(nextMax ?? null))

    if (prevMax && !nextMax) {
      animateMaximizedPane(prevMax, "collapse")
    }
    if (nextMax) {
      animateMaximizedPane(nextMax, "expand")
    }
  })

  // Watch for pane changes and animate
  createEffect(() => {
    const currentIds = props.panes.map((p) => p.id)
    const prevIds = untrack(() => paneIds())
    const currentPage = multiPane.currentPage()
    const prevPage = untrack(() => lastPage())

    // Update tracked state (untracked to prevent re-triggering)
    untrack(() => {
      setPaneIds(currentIds)
      setLastPage(currentPage)
    })

    if (pendingFrame) cancelAnimationFrame(pendingFrame)
    pendingFrame = undefined

    // Skip initial mount
    if (prevIds.length === 0) {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined
        if (disposed) return
        previousRects = capturePositions()
      })
      return
    }

    // Skip animation on page switch (just capture new positions)
    if (currentPage !== prevPage) {
      // Clean up refs for removed panes (important when animations move DOM into the overlay)
      const currentIdSet = new Set(currentIds)
      for (const id of prevIds) {
        if (currentIdSet.has(id)) continue
        paneAnimations.get(id)?.cancel()
        paneAnimations.delete(id)
        const body = paneBodyRefs.get(id)
        const slot = paneRefs.get(id)
        if (body && body.parentElement && body.parentElement !== slot) {
          body.remove()
        }
        paneBodyRefs.delete(id)
        paneRefs.delete(id)
      }
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined
        if (disposed) return
        pruneOverlay(currentIdSet)
        previousRects = capturePositions()
      })
      return
    }

    // Clean up refs for removed panes
    const currentIdSet = new Set(currentIds)
    for (const id of prevIds) {
      if (!currentIdSet.has(id)) {
        paneAnimations.get(id)?.cancel()
        paneAnimations.delete(id)
        const body = paneBodyRefs.get(id)
        const slot = paneRefs.get(id)
        if (body && body.parentElement && body.parentElement !== slot) {
          body.remove()
        }
        paneBodyRefs.delete(id)
        paneRefs.delete(id)
      }
    }

    // Wait for DOM to update with new panes
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = undefined
      if (disposed) return
      if (!containerRef) return
      if (!overlayRef) return

      pruneOverlay(currentIdSet)
      const containerRect = containerRef.getBoundingClientRect()
      const prevIdSet = new Set(prevIds)
      const maxId = untrack(() => maximizedPaneId())

      for (const [id, el] of paneRefs) {
        if (maxId && id === maxId) continue
        // Skip panes with active maximize animations to avoid conflicting animations
        if (maximizeAnimations.has(id)) continue
        const body = paneBodyRefs.get(id)
        if (!body) continue
        body.dataset.paneId = id

        const isNew = !prevIdSet.has(id)
        const prevRect = previousRects.get(id)

        if (isNew || !prevRect) {
          paneAnimations.get(id)?.cancel()
          paneAnimations.delete(id)
          restorePaneBody(id)
          // New pane - fade in using Web Animations API
          const anim = body.animate(
            [
              { opacity: 0, transform: "translate3d(0, 8px, 0)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: FLIP_DURATION, easing: "ease-out" },
          )
          paneAnimations.set(id, anim)
          anim.finished.then(
            () => {
              if (disposed) return
              if (paneAnimations.get(id) !== anim) return
              paneAnimations.delete(id)
            },
            () => {},
          )
          continue
        }

        const currentRect = el.getBoundingClientRect()
        const oldLeft = prevRect.left - containerRect.left
        const oldTop = prevRect.top - containerRect.top
        const newLeft = currentRect.left - containerRect.left
        const newTop = currentRect.top - containerRect.top
        const moveX = Math.abs(oldLeft - newLeft)
        const moveY = Math.abs(oldTop - newTop)
        const widthDelta = Math.abs(prevRect.width - currentRect.width)
        const heightDelta = Math.abs(prevRect.height - currentRect.height)

        // Skip if no significant change
        if (moveX < 1 && moveY < 1 && widthDelta < 1 && heightDelta < 1) {
          if (!paneAnimations.get(id)) restorePaneBody(id)
          continue
        }

        paneAnimations.get(id)?.cancel()
        paneAnimations.delete(id)

        // Save scroll positions before DOM move
        const scrollPositions = snapshotScroll(body)

        overlayRef.appendChild(body)

        // Restore scroll positions after DOM move
        restoreScroll(scrollPositions)

        body.style.position = "absolute"
        body.style.left = `${oldLeft}px`
        body.style.top = `${oldTop}px`
        body.style.width = `${prevRect.width}px`
        body.style.height = `${prevRect.height}px`
        body.style.pointerEvents = "none"

        const anim = body.animate(
          [
            { left: `${oldLeft}px`, top: `${oldTop}px`, width: `${prevRect.width}px`, height: `${prevRect.height}px` },
            {
              left: `${newLeft}px`,
              top: `${newTop}px`,
              width: `${currentRect.width}px`,
              height: `${currentRect.height}px`,
            },
          ],
          { duration: FLIP_DURATION, easing: "ease-out" },
        )
        paneAnimations.set(id, anim)
        anim.finished.then(
          () => {
            if (disposed) return
            if (paneAnimations.get(id) !== anim) return
            restorePaneBody(id)
            paneAnimations.delete(id)
          },
          () => {},
        )
      }

      previousRects = capturePositions()
    })
  })

  const [colSizes, setColSizes] = createSignal<number[] | null>(null)
  const [rowSizes, setRowSizes] = createSignal<number[] | null>(null)

  createEffect(() => {
    const page = multiPane.currentPage()
    const nextLayout = layout()
    const saved = untrack(() => multiPane.grid.get(page, nextLayout))
    setColSizes(saved.colSizes ?? null)
    setRowSizes(saved.rowSizes ?? null)
  })

  function sum(values: number[]) {
    return values.reduce((a, b) => a + b, 0)
  }

  function minTrackPx(count: number, containerSize: number, baseMin: number) {
    const safeCount = Math.max(count, 1)
    const totalGapSpace = (safeCount - 1) * GRID_GAP
    const availableSpace = Math.max(containerSize - totalGapSpace, 1)
    const usableSpace = Math.max(availableSpace * (1 - MIN_TRACK_SLACK), 1)
    return Math.min(baseMin, usableSpace / safeCount)
  }

  function handleCenterPx(count: number, sizes: number[], index: number, containerSize: number) {
    const totalGapSpace = (count - 1) * GRID_GAP
    const availableSpace = Math.max(containerSize - totalGapSpace, 1)
    const totalFr = sum(sizes)
    const beforeFr = sum(sizes.slice(0, index + 1))
    const fraction = beforeFr / totalFr
    return availableSpace * fraction + index * GRID_GAP + GRID_GAP / 2
  }

  function resizeAdjacent(
    count: number,
    startSizes: number[],
    index: number,
    handlePos: number,
    containerSize: number,
    minPx: number,
  ) {
    const totalGapSpace = (count - 1) * GRID_GAP
    const availableSpace = Math.max(containerSize - totalGapSpace, 1)
    const totalFr = sum(startSizes)
    const startPx = startSizes.map((s) => (s / totalFr) * availableSpace)
    const beforePx = sum(startPx.slice(0, index))
    const afterPx = sum(startPx.slice(index + 2))
    const pairSpace = availableSpace - beforePx - afterPx
    if (pairSpace <= 1) return startSizes

    const contentPosBefore = handlePos - index * GRID_GAP - GRID_GAP / 2
    const desiredLeft = contentPosBefore - beforePx
    const minPairPx = Math.min(minPx, pairSpace / 2)
    const leftPx = Math.min(Math.max(desiredLeft, minPairPx), pairSpace - minPairPx)
    const rightPx = pairSpace - leftPx
    const nextSizes = [...startSizes]
    nextSizes[index] = (leftPx / availableSpace) * totalFr
    nextSizes[index + 1] = (rightPx / availableSpace) * totalFr
    return nextSizes
  }

  // Use fr units for proper gap handling
  const actualGridCols = createMemo(() => {
    const cols = layout().columns
    const sizes = colSizes()
    if (sizes && sizes.length === cols) {
      return sizes.map((s) => `${s}fr`).join(" ")
    }
    return `repeat(${cols}, 1fr)`
  })

  const actualGridRows = createMemo(() => {
    const rows = layout().rows
    const sizes = rowSizes()
    if (sizes && sizes.length === rows) {
      return sizes.map((s) => `${s}fr`).join(" ")
    }
    return `repeat(${rows}, 1fr)`
  })

  function handleResizeStart(type: "col" | "row", index: number, e: MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const count = type === "col" ? layout().columns : layout().rows

    // Initialize sizes if not set
    const currentSizes = type === "col" ? colSizes() : rowSizes()
    const startSizes = currentSizes && currentSizes.length === count ? currentSizes : Array(count).fill(1)

    const startRect = containerRef?.getBoundingClientRect()
    if (!startRect) return
    const startContainerSize = type === "col" ? startRect.width : startRect.height
    const startCursorPos = type === "col" ? e.clientX - startRect.left : e.clientY - startRect.top
    const startHandlePos = handleCenterPx(count, startSizes, index, startContainerSize)
    const cursorOffset = startCursorPos - startHandlePos

    document.body.style.userSelect = "none"
    document.body.style.cursor = type === "col" ? "col-resize" : "row-resize"

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!containerRef) return

      const rect = containerRef.getBoundingClientRect()
      const containerSize = type === "col" ? rect.width : rect.height
      const cursorPos = type === "col" ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top
      const handlePos = cursorPos - cursorOffset
      const minPx =
        type === "col"
          ? minTrackPx(count, containerSize, MIN_PANE_WIDTH)
          : minTrackPx(count, containerSize, MIN_PANE_HEIGHT)
      const newSizes = resizeAdjacent(count, startSizes, index, handlePos, containerSize, minPx)

      if (type === "col") {
        setColSizes(newSizes)
        return
      }
      setRowSizes(newSizes)
    }

    const cleanup = () => {
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      const page = multiPane.currentPage()
      const nextLayout = layout()
      if (type === "col") {
        const sizes = colSizes()
        if (sizes && sizes.length === nextLayout.columns) multiPane.grid.set(page, nextLayout, { colSizes: sizes })
        resizeCleanup = null
        return
      }
      const sizes = rowSizes()
      if (sizes && sizes.length === nextLayout.rows) multiPane.grid.set(page, nextLayout, { rowSizes: sizes })
      resizeCleanup = null
    }

    const onMouseUp = () => cleanup()

    resizeCleanup = cleanup
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  function handleCornerResizeStart(colIndex: number, rowIndex: number, e: MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const cols = layout().columns
    const rows = layout().rows
    const currentCols = colSizes()
    const currentRows = rowSizes()
    const startCols = currentCols && currentCols.length === cols ? currentCols : Array(cols).fill(1)
    const startRows = currentRows && currentRows.length === rows ? currentRows : Array(rows).fill(1)

    const startRect = containerRef?.getBoundingClientRect()
    if (!startRect) return
    const startColPos = e.clientX - startRect.left
    const startRowPos = e.clientY - startRect.top
    const startHandleX = handleCenterPx(cols, startCols, colIndex, startRect.width)
    const startHandleY = handleCenterPx(rows, startRows, rowIndex, startRect.height)
    const cursorOffsetX = startColPos - startHandleX
    const cursorOffsetY = startRowPos - startHandleY

    document.body.style.userSelect = "none"
    document.body.style.cursor = "nwse-resize"

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!containerRef) return

      const rect = containerRef.getBoundingClientRect()
      const colPos = moveEvent.clientX - rect.left
      const rowPos = moveEvent.clientY - rect.top
      const handleX = colPos - cursorOffsetX
      const handleY = rowPos - cursorOffsetY
      const minColPx = minTrackPx(cols, rect.width, MIN_PANE_WIDTH)
      const minRowPx = minTrackPx(rows, rect.height, MIN_PANE_HEIGHT)
      const newCols = resizeAdjacent(cols, startCols, colIndex, handleX, rect.width, minColPx)
      const newRows = resizeAdjacent(rows, startRows, rowIndex, handleY, rect.height, minRowPx)

      setColSizes(newCols)
      setRowSizes(newRows)
    }

    const cleanup = () => {
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      const page = multiPane.currentPage()
      const nextLayout = layout()
      const nextCols = colSizes()
      const nextRows = rowSizes()
      if (
        nextCols &&
        nextCols.length === cols &&
        nextRows &&
        nextRows.length === rows &&
        nextLayout.columns === cols &&
        nextLayout.rows === rows
      ) {
        multiPane.grid.set(page, nextLayout, { colSizes: nextCols, rowSizes: nextRows })
      }
      resizeCleanup = null
    }

    const onMouseUp = () => cleanup()

    resizeCleanup = cleanup
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  const colPositions = createMemo(() => {
    const cols = layout().columns
    const sizes = colSizes() ?? Array(cols).fill(1)
    const total = sizes.reduce((a, b) => a + b, 0)
    const totalGaps = (cols - 1) * GRID_GAP
    return Array.from({ length: cols - 1 }, (_, index) => {
      const before = sizes.slice(0, index + 1).reduce((a, b) => a + b, 0)
      const fraction = before / total
      const pxOffset = -fraction * totalGaps + index * GRID_GAP + GRID_GAP / 2
      return `calc(${fraction * 100}% + ${pxOffset}px)`
    })
  })

  const rowPositions = createMemo(() => {
    const rows = layout().rows
    const sizes = rowSizes() ?? Array(rows).fill(1)
    const total = sizes.reduce((a, b) => a + b, 0)
    const totalGaps = (rows - 1) * GRID_GAP
    return Array.from({ length: rows - 1 }, (_, index) => {
      const before = sizes.slice(0, index + 1).reduce((a, b) => a + b, 0)
      const fraction = before / total
      const pxOffset = -fraction * totalGaps + index * GRID_GAP + GRID_GAP / 2
      return `calc(${fraction * 100}% + ${pxOffset}px)`
    })
  })

  const cornerPositions = createMemo(() => {
    const cols = colPositions()
    const rows = rowPositions()
    return cols.flatMap((left, colIndex) =>
      rows.map((top, rowIndex) => ({
        left,
        top,
        col: colIndex,
        row: rowIndex,
      })),
    )
  })

  function spanningPane(index: number, count: number, cols: number, rows: number) {
    if (rows < 2) return undefined
    const remainder = count % cols
    if (remainder === 0) return undefined
    const rowAbove = rows - 1
    const rowAboveStart = (rows - 2) * cols
    const rowAboveEnd = rowAboveStart + cols - 1
    if (index < rowAboveStart || index > rowAboveEnd) return undefined
    const colIndex = index - rowAboveStart
    if (colIndex < remainder) return undefined
    const startCol = colIndex + 1
    return { row: rowAbove, startCol }
  }

  function paneStyle(index: number) {
    const cols = layout().columns
    const rows = layout().rows
    const count = props.panes.length
    const span = spanningPane(index, count, cols, rows)
    if (!span) return undefined
    return {
      "grid-column": `${span.startCol} / span 1`,
      "grid-row": `${span.row} / span 2`,
    }
  }

  function paneWrapperStyle(id: string, index: number) {
    const base = paneStyle(index)
    return base
  }

  return (
    <div
      ref={containerRef}
      class="flex-1 min-h-0 relative"
      onMouseDown={radialDial.handlers.onMouseDown}
      onMouseMove={radialDial.handlers.onMouseMove}
      onMouseUp={radialDial.handlers.onMouseUp}
      onContextMenu={radialDial.handlers.onContextMenu}
    >
      {/* Main grid */}
      <div
        class="size-full grid"
        style={{
          "grid-template-columns": actualGridCols(),
          "grid-template-rows": actualGridRows(),
          gap: `${GRID_GAP}px`,
        }}
      >
        <For each={props.panes}>
          {(pane, index) => {
            const hidden = createMemo(() => {
              const max = maximizedPaneId()
              if (!max) return false
              return pane.id !== max
            })

            return (
              <div
                ref={(el) => paneRefs.set(pane.id, el)}
                class="relative min-w-0 min-h-0 overflow-hidden"
                classList={{ "pointer-events-none": hidden() }}
                style={paneWrapperStyle(pane.id, index())}
              >
                <div
                  ref={(el) => paneBodyRefs.set(pane.id, el)}
                  class="size-full overflow-hidden transition-[opacity,transform] duration-200 ease-out"
                  style={{
                    opacity: hidden() ? 0 : 1,
                    transform: hidden() ? "scale(0.98)" : "scale(1)",
                  }}
                >
                  {props.renderPane(pane)}
                </div>
              </div>
            )
          }}
        </For>
      </div>

      {/* Overlay layer for box-resize animations */}
      <div ref={overlayRef} class="absolute inset-0 z-30" classList={{ "pointer-events-none": !maximizedPaneId() }} />

      <Show when={!maximizedPaneId()}>
        {/* Corner resize handles */}
        <For each={cornerPositions()}>
          {(corner) => (
            <div
              class="absolute -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize z-20"
              style={{
                left: corner.left,
                top: corner.top,
                width: `${CORNER_HIT_SIZE}px`,
                height: `${CORNER_HIT_SIZE}px`,
              }}
              onMouseDown={(e) => handleCornerResizeStart(corner.col, corner.row, e)}
            />
          )}
        </For>

        {/* Column resize handles */}
        <For each={colPositions()}>
          {(handlePos, index) => {
            return (
              <div
                class="absolute top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize z-10 group"
                style={{ left: handlePos }}
                onMouseDown={(e) => handleResizeStart("col", index(), e)}
              >
                <div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 group-hover:bg-border-accent-base group-active:bg-border-accent-base transition-colors duration-75" />
              </div>
            )
          }}
        </For>

        {/* Row resize handles */}
        <For each={rowPositions()}>
          {(handlePos, index) => {
            return (
              <div
                class="absolute left-0 right-0 h-3 -translate-y-1/2 cursor-row-resize z-10 group"
                style={{ top: handlePos }}
                onMouseDown={(e) => handleResizeStart("row", index(), e)}
              >
                <div class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 group-hover:bg-border-accent-base group-active:bg-border-accent-base transition-colors duration-75" />
              </div>
            )
          }}
        </For>
      </Show>

      {/* Radial dial menu */}
      <Show when={radialDial.isOpen()}>
        <Portal>
          <RadialDialMenu
            centerX={radialDial.centerX()}
            centerY={radialDial.centerY()}
            highlightedAction={radialDial.highlightedAction()}
          />
        </Portal>
      </Show>
    </div>
  )
}
