import { createStore, produce } from "solid-js/store"
import { batch, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { triggerShiftingGradient } from "@/components/shifting-gradient"
import { paneCache } from "@/components/multi-pane/pane-cache"
import { useGlobalSDK } from "@/context/global-sdk"

export type PaneConfig = {
  id: string
  directory?: string
  worktree?: string
  sessionId?: string
}

export type PaneLayout = {
  columns: number
  rows: number
}

type PaneGridState = {
  columns: number
  rows: number
  colSizes?: number[]
  rowSizes?: number[]
}

type MultiPaneState = {
  panes: PaneConfig[]
  currentPage: number
  focusedPaneId?: string
  maximizedPaneId?: string
  grid: Record<number, PaneGridState | undefined>
}

const MAX_PANES_PER_PAGE = 12
const MAX_TOTAL_PANES = 48 // 4 pages worth

function generatePaneId() {
  return Math.random().toString(36).slice(2, 10)
}

function calculateLayout(paneCount: number): PaneLayout {
  if (paneCount <= 1) return { columns: 1, rows: 1 }
  if (paneCount === 2) return { columns: 2, rows: 1 }
  if (paneCount <= 4) return { columns: 2, rows: 2 }
  if (paneCount <= 6) return { columns: 3, rows: 2 }
  if (paneCount <= 8) return { columns: 4, rows: 2 }
  if (paneCount <= 9) return { columns: 3, rows: 3 }
  return { columns: 4, rows: 3 }
}

export const { use: useMultiPane, provider: MultiPaneProvider } = createSimpleContext({
  name: "MultiPane",
  init: () => {
    const globalSDK = useGlobalSDK()
    const [store, setStore] = createStore<MultiPaneState>({
      panes: [],
      currentPage: 0,
      focusedPaneId: undefined,
      maximizedPaneId: undefined,
      grid: {},
    })

    const totalPages = createMemo(() => Math.max(1, Math.ceil(store.panes.length / MAX_PANES_PER_PAGE)))

    const visiblePanes = createMemo(() => {
      const start = store.currentPage * MAX_PANES_PER_PAGE
      const end = start + MAX_PANES_PER_PAGE
      return store.panes.slice(start, end)
    })

    const layout = createMemo(() => calculateLayout(visiblePanes().length))

    const focusedPane = createMemo(() => {
      if (!store.focusedPaneId) return visiblePanes()[0]
      return store.panes.find((p) => p.id === store.focusedPaneId)
    })

    function copyPaneSetup(sourceId: string | undefined, targetId: string | undefined) {
      if (!sourceId) return
      if (!targetId) return
      const cached = paneCache.get(sourceId)
      if (!cached) return
      paneCache.set(targetId, {
        agent: cached.agent,
        model: cached.model,
        variant: cached.variant,
        modeId: cached.modeId,
        thinking: cached.thinking,
      })
    }

    function addPane(directory?: string, sessionId?: string, options?: { focus?: boolean; worktree?: string }) {
      if (store.panes.length >= MAX_TOTAL_PANES) {
        return undefined
      }
      const id = generatePaneId()
      const pane: PaneConfig = { id, directory, worktree: options?.worktree, sessionId }

      const total = store.panes.length
      const targetPage = Math.floor(total / MAX_PANES_PER_PAGE)
      const pageStart = targetPage * MAX_PANES_PER_PAGE
      const visibleCount = total - pageStart
      const prevLayout = calculateLayout(visibleCount)
      const nextLayout = calculateLayout(visibleCount + 1)
      const shouldInsertIntoExpansionSlot =
        visibleCount > 0 && nextLayout.rows === prevLayout.rows && nextLayout.columns > prevLayout.columns
      const localInsertIndex = shouldInsertIntoExpansionSlot ? Math.min(prevLayout.columns, visibleCount) : visibleCount

      const nextPanes = [...store.panes]
      nextPanes.splice(pageStart + localInsertIndex, 0, pane)
      setStore("panes", nextPanes)
      // Reset maximized state when adding a new pane
      setStore("maximizedPaneId", undefined)
      const shouldFocus = options?.focus ?? true
      if (shouldFocus) {
        setStore("focusedPaneId", id)
      }
      // Use length-1 because pages are 0-indexed (12 panes with perPage=12 should be page 0)
      const newPage = Math.floor((store.panes.length - 1) / MAX_PANES_PER_PAGE)
      if (newPage !== store.currentPage) {
        setStore("currentPage", newPage)
      }
      triggerShiftingGradient()
      return id
    }

    function addPaneFromFocused(directoryFallback?: string, options?: { focus?: boolean }) {
      const focused = focusedPane()
      const directory = focused?.directory ?? directoryFallback
      const worktree = focused?.worktree
      const nextOptions = options ? { ...options, worktree } : { worktree }
      const id = addPane(directory, undefined, nextOptions)
      copyPaneSetup(focused?.id, id)
      return id
    }

    return {
      panes: createMemo(() => store.panes),
      visiblePanes,
      currentPage: createMemo(() => store.currentPage),
      totalPages,
      layout,
      focusedPaneId: createMemo(() => store.focusedPaneId),
      focusedPane,
      maximizedPaneId: createMemo(() => store.maximizedPaneId),
      grid: {
        get(page: number, nextLayout: PaneLayout) {
          const entry = store.grid[page]
          if (!entry) return {}
          if (entry.columns !== nextLayout.columns) return {}
          if (entry.rows !== nextLayout.rows) return {}
          return { colSizes: entry.colSizes, rowSizes: entry.rowSizes }
        },
        set(page: number, nextLayout: PaneLayout, next: { colSizes?: number[]; rowSizes?: number[] }) {
          const entry = store.grid[page]
          if (!entry) {
            setStore("grid", page, {
              columns: nextLayout.columns,
              rows: nextLayout.rows,
              colSizes: next.colSizes,
              rowSizes: next.rowSizes,
            })
            return
          }

          if (entry.columns !== nextLayout.columns || entry.rows !== nextLayout.rows) {
            setStore("grid", page, {
              columns: nextLayout.columns,
              rows: nextLayout.rows,
              colSizes: next.colSizes,
              rowSizes: next.rowSizes,
            })
            return
          }

          if (next.colSizes) setStore("grid", page, "colSizes", next.colSizes)
          if (next.rowSizes) setStore("grid", page, "rowSizes", next.rowSizes)
        },
        clear() {
          setStore("grid", {})
        },
      },

      addPane,
      addPaneFromFocused,

      removePane(id: string) {
        const index = store.panes.findIndex((p) => p.id === id)
        if (index === -1) return

        if (store.panes.length === 1) {
          batch(() => {
            setStore("panes", index, "sessionId", undefined)
            setStore("focusedPaneId", id)
            setStore("maximizedPaneId", undefined)
            setStore("currentPage", 0)
          })
          triggerShiftingGradient()
          return
        }

        const remaining = store.panes.filter((p) => p.id !== id)
        const isMaximized = store.maximizedPaneId === id

        batch(() => {
          setStore("panes", remaining)

          if (store.focusedPaneId === id) {
            const newFocus = remaining[Math.min(index, remaining.length - 1)]
            setStore("focusedPaneId", newFocus?.id)
          }

          if (isMaximized) {
            setStore("maximizedPaneId", undefined)
          }

          const newTotalPages = Math.max(1, Math.ceil(remaining.length / MAX_PANES_PER_PAGE))
          if (store.currentPage >= newTotalPages) {
            setStore("currentPage", newTotalPages - 1)
          }
        })

        triggerShiftingGradient()
      },

      updatePane(id: string, updates: Partial<Omit<PaneConfig, "id">>) {
        const index = store.panes.findIndex((p) => p.id === id)
        if (index === -1) return
        // Update individual properties to preserve object reference
        // This prevents <For> from remounting components when pane data changes
        for (const key of Object.keys(updates) as Array<keyof typeof updates>) {
          setStore("panes", index, key, updates[key])
        }
      },

      setFocused(id: string) {
        if (store.panes.find((p) => p.id === id)) {
          setStore("focusedPaneId", id)
        }
      },

      nextPage() {
        if (store.currentPage < totalPages() - 1) {
          setStore("currentPage", store.currentPage + 1)
        }
      },

      prevPage() {
        if (store.currentPage > 0) {
          setStore("currentPage", store.currentPage - 1)
        }
      },

      goToPage(page: number) {
        if (page >= 0 && page < totalPages()) {
          setStore("currentPage", page)
        }
      },

      movePane(id: string, toIndex: number) {
        const index = store.panes.findIndex((p) => p.id === id)
        if (index === -1) return

        const clampedIndex = Math.max(0, Math.min(toIndex, store.panes.length - 1))
        if (clampedIndex === index) return

        setStore(
          "panes",
          produce((panes) => {
            panes.splice(clampedIndex, 0, panes.splice(index, 1)[0])
          }),
        )
      },

      swapPanes(firstId: string, secondId: string) {
        if (firstId === secondId) return
        const firstIndex = store.panes.findIndex((pane) => pane.id === firstId)
        if (firstIndex === -1) return
        const secondIndex = store.panes.findIndex((pane) => pane.id === secondId)
        if (secondIndex === -1) return
        setStore(
          "panes",
          produce((panes) => {
            const first = panes[firstIndex]
            const second = panes[secondIndex]
            panes[firstIndex] = second
            panes[secondIndex] = first
          }),
        )
      },

      focusPaneByIndex(index: number) {
        const pane = visiblePanes()[index]
        if (pane) {
          setStore("focusedPaneId", pane.id)
        }
      },

      clear() {
        batch(() => {
          setStore("panes", [])
          setStore("currentPage", 0)
          setStore("focusedPaneId", undefined)
          setStore("maximizedPaneId", undefined)
          setStore("grid", {})
        })
      },

      async clonePane(id: string) {
        const pane = store.panes.find((p) => p.id === id)
        if (!pane || store.panes.length >= MAX_TOTAL_PANES) return undefined

        const insert = (sessionId?: string, directory?: string, worktree?: string) => {
          if (store.panes.length >= MAX_TOTAL_PANES) return undefined
          const index = store.panes.findIndex((p) => p.id === id)
          if (index === -1) return undefined

          const newId = generatePaneId()
          const clonedPane: PaneConfig = {
            id: newId,
            directory,
            worktree,
            sessionId,
          }

          const cloneIndex = index + 1
          const newPanes = [...store.panes]
          newPanes.splice(cloneIndex, 0, clonedPane)

          batch(() => {
            setStore("panes", newPanes)
            setStore("focusedPaneId", newId)
          })

          const newPage = Math.floor(cloneIndex / MAX_PANES_PER_PAGE)
          if (newPage !== store.currentPage) {
            setStore("currentPage", newPage)
          }

          return newId
        }

        if (!pane.sessionId) {
          return insert(pane.sessionId, pane.directory, pane.worktree)
        }

        if (!pane.directory) {
          showToast({
            title: "Unable to clone session",
            description: "Missing project directory for this session.",
          })
          return undefined
        }

        const directory = pane.worktree ?? pane.directory
        const created = await globalSDK.client.session
          .fork({
            sessionID: pane.sessionId,
            directory,
          })
          .then((result) => result.data)
          .catch(() => {
            showToast({
              title: "Unable to clone session",
              description: "Failed to fork session.",
            })
            return undefined
          })

        if (!created) return undefined
        const nextWorktree =
          created.directory && created.directory !== pane.directory ? created.directory : pane.worktree
        return insert(created.id, pane.directory, nextWorktree)
      },

      toggleMaximize(id: string) {
        if (store.maximizedPaneId === id) {
          setStore("maximizedPaneId", undefined)
          return
        }
        batch(() => {
          setStore("maximizedPaneId", id)
          setStore("focusedPaneId", id)
        })
      },
    }
  },
})
