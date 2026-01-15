import { Show, createMemo, onMount, createEffect, on, createSignal, batch, type JSX } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { useMultiPane, type PaneConfig } from "@/context/multi-pane"
import { PaneGrid } from "@/components/pane-grid"
import { SessionPane } from "@/components/session-pane"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider, useLocal } from "@/context/local"
import { DataProvider } from "@opencode-ai/ui/context"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { DragDropProvider, DragDropSensors, DragOverlay, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { getDraggableId } from "@/utils/solid-dnd"
import { ShiftingGradient, GRAIN_DATA_URI } from "@/components/shifting-gradient"
import { useTheme } from "@opencode-ai/ui/theme"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogDeleteWorktree } from "@/components/dialog-delete-worktree"
import { MultiPanePromptPanel } from "@/components/multi-pane/prompt-panel"
import { PaneHome } from "@/components/multi-pane/pane-home"
import { getPaneProjectLabel, getPaneState, getPaneTitle } from "@/utils/pane"
import { useCommand } from "@/context/command"
import { normalizeDirectoryKey } from "@/utils/directory"

type MultiPanePageProps = {
  initialDir?: string
  initialSession?: string
}

type AskUserReplyInput = {
  requestID: string
  answers: Record<string, string>
  answerSets?: string[][]
  sessionID?: string
  source?: "askuser" | "question"
  reject?: boolean
}

type AskUserRequestEntry = {
  id: string
  source?: "askuser" | "question"
  questions?: Array<{ question: string }>
}

type PlanModeReplyInput = {
  requestID: string
  approved: boolean
}

type SyncContext = ReturnType<typeof useSync>

const findAskUserRequest = (sync: SyncContext, requestID: string, sessionID?: string) => {
  const store = sync.data.askuser ?? {}
  if (sessionID && store[sessionID]) {
    return store[sessionID].find((req) => req.id === requestID)
  }
  for (const requests of Object.values(store)) {
    const match = requests.find((req) => req.id === requestID)
    if (match) return match
  }
  return undefined
}

const buildQuestionAnswers = (input: AskUserReplyInput, request: AskUserRequestEntry | undefined) => {
  if (input.answerSets) return input.answerSets
  if (!request?.questions) return []
  return request.questions.map((question) => {
    const value = input.answers[question.question] ?? ""
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  })
}

const createAskUserResponder = (sync: SyncContext, baseUrl: string, directory: string) => {
  return async (input: AskUserReplyInput) => {
    const request = findAskUserRequest(sync, input.requestID, input.sessionID) as AskUserRequestEntry | undefined
    const source = input.source ?? request?.source ?? "askuser"

    if (source === "question") {
      if (input.reject) {
        const response = await fetch(`${baseUrl}/question/${input.requestID}/reject`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-directory": directory,
          },
        })
        return response.json()
      }
      const response = await fetch(`${baseUrl}/question/${input.requestID}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": directory,
        },
        body: JSON.stringify({ answers: buildQuestionAnswers(input, request) }),
      })
      return response.json()
    }

    if (input.reject) {
      const response = await fetch(`${baseUrl}/askuser/${input.requestID}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": directory,
        },
      })
      return response.json()
    }

    const response = await fetch(`${baseUrl}/askuser/${input.requestID}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": directory,
      },
      body: JSON.stringify({ answers: input.answers }),
    })
    return response.json()
  }
}

const createPlanModeResponder = (baseUrl: string, directory: string) => {
  return async (input: PlanModeReplyInput) => {
    const response = await fetch(`${baseUrl}/planmode/${input.requestID}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": directory,
      },
      body: JSON.stringify({ approved: input.approved }),
    })
    return response.json()
  }
}

// Bridge component to connect LocalProvider's agent setter to DataProvider
function AgentBridge(props: { setAgentRef: (fn: (name: string) => void) => void; children: any }) {
  const local = useLocal()
  props.setAgentRef((name: string) => local.agent.set(name))
  return props.children
}

function PaneProviders(props: { paneId: string; directory: string; children: any }) {
  const sync = useSync()
  const sdk = useSDK()
  const respondToPermission = (input: {
    sessionID: string
    permissionID: string
    response: "once" | "always" | "reject"
  }) => sdk.client.permission.respond(input)
  const respondToAskUser = createAskUserResponder(sync, sdk.url, props.directory)
  const respondToPlanMode = createPlanModeResponder(sdk.url, props.directory)

  // Use a ref to capture the agent setter from inside LocalProvider
  let setAgentFn: ((name: string) => void) | undefined

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onPermissionRespond={respondToPermission}
      onAskUserRespond={respondToAskUser}
      onPlanModeRespond={respondToPlanMode}
      onSetAgent={(name) => setAgentFn?.(name)}
      onReasoningPrefetch={(input) => sync.session.prefetchReasoning(input.sessionID, input.messageID)}
    >
      <LocalProvider>
        <AgentBridge setAgentRef={(fn) => (setAgentFn = fn)}>
          <TerminalProvider paneId={props.paneId}>
            <FileProvider>
              <PromptProvider paneId={props.paneId}>{props.children}</PromptProvider>
            </FileProvider>
          </TerminalProvider>
        </AgentBridge>
      </LocalProvider>
    </DataProvider>
  )
}

// Provider wrapper for each pane (provides Local/Terminal context needed by SessionPane)
function PaneSyncedProviders(props: { paneId: string; directory: string; children: any }) {
  return (
    <PaneProviders paneId={props.paneId} directory={props.directory}>
      {props.children}
    </PaneProviders>
  )
}

// Wrapper that provides SDK/Sync context for the global prompt
function GlobalPromptSynced(props: { paneId: string; directory: string; sessionId?: string }) {
  return (
    <PaneProviders paneId={props.paneId} directory={props.directory}>
      <MultiPanePromptPanel paneId={props.paneId} sessionId={props.sessionId} />
    </PaneProviders>
  )
}


// Global prompt wrapper that switches based on focused pane
function GlobalPromptWrapper() {
  const multiPane = useMultiPane()
  const focused = createMemo(() => multiPane.focusedPane())
  const focusedDirectory = createMemo(() => {
    const pane = focused()
    if (!pane) return
    return pane.worktree ?? pane.directory
  })

  return (
    <Show when={focusedDirectory()}>
      {(directory) => (
        <SDKProvider directory={directory()}>
          <SyncProvider>
            <Show when={focused()}>
              {(pane) => (
                <GlobalPromptSynced paneId={pane().id} directory={directory()} sessionId={pane().sessionId} />
              )}
            </Show>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}


function MultiPaneContent(props: MultiPanePageProps) {
  const multiPane = useMultiPane()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const theme = useTheme()
  const command = useCommand()
  const [searchParams, setSearchParams] = useSearchParams()
  const [activePaneDraggable, setActivePaneDraggable] = createSignal<string | undefined>(undefined)
  const dragOverlayBackground = "hsl(from var(--background-base) h s l / 0.55)"
  const overlayBackground = "hsl(from var(--background-base) h s l / 0.25)"
  const paneDirectory = (pane: PaneConfig | undefined) => pane?.worktree ?? pane?.directory

  const isCrisp = () => theme.activeGradientMode() === "crisp"
  const backdropStyle = (): JSX.CSSProperties => {
    const custom = theme.activeCustomGradient()
    const baseBlur = isCrisp() ? 4 : 24
    const blurAmount = custom ? baseBlur * (custom.blur / 100) : baseBlur
    const blur = isCrisp() ? `blur(${blurAmount}px)` : `blur(${blurAmount}px) saturate(1.05)`
    return {
      "background-color": overlayBackground,
      "backdrop-filter": blur,
      "-webkit-backdrop-filter": blur,
    }
  }
  const grainStyle = (): JSX.CSSProperties => {
    const custom = theme.activeCustomGradient()
    const baseOpacity = isCrisp() ? 0.65 : 0.24
    const noiseOpacity = custom ? baseOpacity * (custom.noise / 100) : baseOpacity
    return {
      "background-image": `url("${GRAIN_DATA_URI}")`,
      "background-repeat": "repeat",
      "background-size": "120px 120px",
      "mix-blend-mode": "soft-light",
      filter: "contrast(180%)",
      opacity: String(noiseOpacity),
    }
  }

  const visiblePanes = createMemo(() => multiPane.visiblePanes())
  const hasPanes = createMemo(() => multiPane.panes().length > 0)
  const activePane = createMemo(() => {
    const id = activePaneDraggable()
    if (!id) return undefined
    return multiPane.panes().find((pane) => pane.id === id)
  })
  const activeTitle = createMemo(() => getPaneTitle(activePane(), globalSync))
  const activeProject = createMemo(() => getPaneProjectLabel(activePane()))

  const recentProject = createMemo(() => {
    const sorted = globalSync.data.project.toSorted(
      (a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created),
    )
    return sorted[0]?.worktree
  })
  const defaultProject = createMemo(() => globalSync.data.path.directory)
  const getLastProject = () => recentProject() || defaultProject() || layout.projects.list()[0]?.worktree

  const resolveProjectDirectory = (directory: string | undefined) => {
    if (!directory) return { directory: undefined, worktree: undefined }
    const normalized = normalizeDirectoryKey(directory)
    if (!normalized) return { directory, worktree: undefined }
    const project = globalSync.data.project.find((candidate) => {
      if (normalizeDirectoryKey(candidate.worktree) === normalized) return true
      return (candidate.sandboxes ?? []).some((sandbox) => normalizeDirectoryKey(sandbox) === normalized)
    })
    if (!project) return { directory, worktree: undefined }
    const rootKey = normalizeDirectoryKey(project.worktree)
    const isRoot = rootKey === normalized
    return { directory: project.worktree, worktree: isRoot ? undefined : directory }
  }

  createEffect(() => {
    const panes = multiPane.panes()
    if (panes.length === 0) return
    if (globalSync.data.project.length === 0) return
    batch(() => {
      for (const pane of panes) {
        if (!pane.directory) continue
        const resolved = resolveProjectDirectory(pane.directory)
        if (!resolved.directory) continue
        const nextDirectory = resolved.directory
        const nextWorktree = resolved.worktree ?? pane.worktree
        if (nextDirectory === pane.directory && nextWorktree === pane.worktree) continue
        multiPane.updatePane(pane.id, { directory: nextDirectory, worktree: nextWorktree })
      }
    })
  })

  const focusPaneByOffset = (offset: number) => {
    const panes = visiblePanes()
    if (panes.length === 0) return
    const focusedId = multiPane.focusedPaneId()
    const currentIndex = focusedId ? panes.findIndex((pane) => pane.id === focusedId) : -1
    const baseIndex = currentIndex === -1 ? 0 : currentIndex
    const nextIndex = (baseIndex + offset + panes.length) % panes.length
    const nextPane = panes[nextIndex]
    if (!nextPane) return
    multiPane.setFocused(nextPane.id)
  }

  const handleKeybindAddPane = () => {
    const focused = multiPane.focusedPane()
    const directory = focused?.directory ?? getLastProject()
    const id = multiPane.addPaneFromFocused(directory)
    if (id) return
    showToast({
      title: "Tab limit reached",
      description: "Maximum of 48 tabs allowed",
    })
  }

  const closePaneWithWorktreeCheck = (paneId: string) => {
    const pane = multiPane.panes().find((p) => p.id === paneId)
    const directory = paneDirectory(pane)
    if (!pane?.sessionId || !directory) {
      multiPane.removePane(paneId)
      return
    }

    // Get session info from globalSync
    const store = globalSync.child(directory)[0]
    const session = store.session.find((s) => s.id === pane.sessionId)
    const worktreePath = (session as any)?.worktree?.path

    if (!worktreePath) {
      multiPane.removePane(paneId)
      return
    }

    // Show confirmation dialog for worktree cleanup
    dialog.show(() => (
      <DialogDeleteWorktree
        worktreePath={worktreePath}
        onConfirm={async () => {
          await globalSDK.client.global.worktree.delete({
            directory: worktreePath,
          })
          showToast({
            title: "Worktree deleted",
            variant: "success",
          })
          multiPane.removePane(paneId)
        }}
        onCancel={() => {
          multiPane.removePane(paneId)
        }}
      />
    ))
  }

  const handleKeybindClosePane = () => {
    const focused = multiPane.focusedPaneId()
    if (!focused) return
    closePaneWithWorktreeCheck(focused)
  }

  const handleKeybindClonePane = () => {
    const focused = multiPane.focusedPaneId()
    if (!focused) return
    void multiPane.clonePane(focused)
  }

  const handleKeybindToggleMaximize = () => {
    const focused = multiPane.focusedPaneId()
    if (!focused) return
    multiPane.toggleMaximize(focused)
  }

  command.register(() => {
    const paneCount = visiblePanes().length
    const hasFocus = !!multiPane.focusedPaneId()

    const commands = [
      {
        id: "pane.new",
        title: "New pane",
        description: "Create a new pane",
        category: "Pane",
        keybind: "mod+\\",
        onSelect: handleKeybindAddPane,
      },
      {
        id: "pane.clone",
        title: "Clone pane",
        description: "Duplicate the focused pane",
        category: "Pane",
        keybind: "mod+shift+\\",
        disabled: !hasFocus,
        onSelect: handleKeybindClonePane,
      },
      {
        id: "pane.close",
        title: "Close pane",
        description: "Close the focused pane",
        category: "Pane",
        keybind: "mod+w",
        disabled: !hasFocus,
        onSelect: handleKeybindClosePane,
      },
      {
        id: "pane.focus.next",
        title: "Focus next pane",
        category: "Pane",
        keybind: "mod+],mod+tab",
        disabled: paneCount <= 1,
        onSelect: () => focusPaneByOffset(1),
      },
      {
        id: "pane.focus.previous",
        title: "Focus previous pane",
        category: "Pane",
        keybind: "mod+[,mod+shift+tab",
        disabled: paneCount <= 1,
        onSelect: () => focusPaneByOffset(-1),
      },
      {
        id: "pane.maximize.toggle",
        title: multiPane.maximizedPaneId() ? "Restore pane" : "Maximize pane",
        description: "Toggle pane maximization",
        category: "Pane",
        keybind: "mod+shift+m",
        disabled: !hasFocus,
        onSelect: handleKeybindToggleMaximize,
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `pane.focus.${index + 1}`,
        title: `Focus pane ${index + 1}`,
        category: "Pane",
        keybind: `mod+${index + 1}`,
        disabled: paneCount <= index,
        onSelect: () => multiPane.focusPaneByIndex(index),
      })),
    ]

    return commands
  })

  onMount(() => {
    const rawDir = searchParams.dir
    const rawSession = searchParams.session
    const rawNewTab = searchParams.newTab
    const hasDirParam = typeof rawDir === "string"
    const hasSessionParam = typeof rawSession === "string"
    const dirFromUrl = hasDirParam ? decodeURIComponent(rawDir) : undefined
    const sessionFromUrl = hasSessionParam ? rawSession : undefined
    const wantsNewTab = rawNewTab === "true"
    const initialDir = dirFromUrl ?? props.initialDir
    const initialSession = sessionFromUrl ?? props.initialSession
    const shouldClearParams = hasDirParam || hasSessionParam || wantsNewTab

    if (multiPane.panes().length === 0) {
      if (initialDir) {
        const resolved = resolveProjectDirectory(initialDir)
        const projectDirectory = resolved.directory ?? initialDir
        layout.projects.open(projectDirectory)
        // Add pane with session (if any) and a new tab with same/last project
        multiPane.addPane(projectDirectory, initialSession, { worktree: resolved.worktree })
        if (wantsNewTab) {
          multiPane.addPaneFromFocused(projectDirectory)
        }
        if (shouldClearParams) {
          setSearchParams({ dir: undefined, session: undefined, newTab: undefined })
        }
        return
      }
      const lastProject = getLastProject()
      if (wantsNewTab) {
        multiPane.addPane(lastProject)
        multiPane.addPaneFromFocused(lastProject)
        setSearchParams({ newTab: undefined })
        return
      }
      // No URL params, use most recent project
      multiPane.addPane(lastProject)
      return
    }

    if (!initialDir) return
    if (!wantsNewTab) return
    // Already have panes, but coming from session "New Tab" button
    const resolved = resolveProjectDirectory(initialDir)
    const projectDirectory = resolved.directory ?? initialDir
    layout.projects.open(projectDirectory)
    multiPane.addPane(projectDirectory, initialSession, { worktree: resolved.worktree })
    multiPane.addPaneFromFocused(projectDirectory)
    if (shouldClearParams) {
      setSearchParams({ dir: undefined, session: undefined, newTab: undefined })
    }
  })

  createEffect(
    on(
      () => {
        const rawDir = searchParams.dir
        const rawSession = searchParams.session
        const hasDirParam = typeof rawDir === "string"
        const hasSessionParam = typeof rawSession === "string"
        const dirFromUrl = hasDirParam ? decodeURIComponent(rawDir) : undefined
        const sessionFromUrl = hasSessionParam ? rawSession : undefined
        return {
          dir: dirFromUrl ?? props.initialDir,
          session: sessionFromUrl ?? props.initialSession,
          newTab: searchParams.newTab,
          hasQueryParams: hasDirParam || hasSessionParam,
        }
      },
      (params) => {
        // Skip if newTab param is present (handled by onMount)
        if (params.newTab === "true") return
        // Only handle if we already have panes (not initial load)
        if (multiPane.panes().length === 0) return

        if (!params.dir) return
        const sessionId = params.session
        const focusedPane = multiPane.focusedPane()
        if (focusedPane) {
          const resolved = resolveProjectDirectory(params.dir)
          const projectDirectory = resolved.directory ?? params.dir
          layout.projects.open(projectDirectory)
          multiPane.updatePane(focusedPane.id, {
            directory: projectDirectory,
            sessionId,
            worktree: resolved.worktree,
          })
          multiPane.setFocused(focusedPane.id)
        }
        if (!params.hasQueryParams) return
        setSearchParams({ session: undefined, dir: undefined })
      },
    ),
  )

  function handleAddFirstPane() {
    multiPane.addPane(getLastProject())
  }

  function handlePaneDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setActivePaneDraggable(id)
    multiPane.setFocused(id)
  }

  function handlePaneDragEnd(event: DragEvent) {
    setActivePaneDraggable(undefined)
    const draggable = event.draggable
    if (!draggable) return
    const droppable = event.droppable
    if (!droppable) return
    const fromId = draggable.id.toString()
    const toId = droppable.id.toString()
    if (fromId === toId) return
    multiPane.swapPanes(fromId, toId)
  }

  return (
    <div class="relative size-full flex flex-col bg-background-base overflow-hidden" style={{ isolation: "isolate" }}>
      <ShiftingGradient class="z-0" />
      <div class="absolute inset-0 pointer-events-none z-10" style={backdropStyle()}>
        <div class="absolute inset-0" style={grainStyle()} />
      </div>
      <div class="relative z-20 flex-1 min-h-0 flex flex-col">
        <Show
          when={hasPanes()}
          fallback={
            <div class="flex-1 flex items-center justify-center">
              <div class="text-center">
                <Icon name="dot-grid" size="large" class="mx-auto mb-4 text-icon-weak" />
                <div class="text-16-medium text-text-strong mb-2">No tabs yet</div>
                <div class="text-14-regular text-text-weak mb-6">Add a tab to start working with multiple sessions</div>
                <Button size="large" onClick={handleAddFirstPane}>
                  <Icon name="plus" size="small" />
                  New Tab
                </Button>
              </div>
            </div>
          }
        >
          <div class="flex-1 min-h-0 flex">
            <div class="flex-1 min-w-0 min-h-0 flex flex-col">
              <DragDropProvider
                onDragStart={handlePaneDragStart}
                onDragEnd={handlePaneDragEnd}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <PaneGrid
                  panes={visiblePanes()}
                  renderPane={(pane) => {
                    const isFocused = createMemo(() => multiPane.focusedPaneId() === pane.id)
                    const state = createMemo(() => getPaneState(pane))
                    const activeDirectory = createMemo(() => pane.worktree ?? pane.directory)
                    return (
                      <Show
                        when={state() === "session"}
                        fallback={
                          <PaneHome
                            paneId={pane.id}
                            isFocused={isFocused}
                            selectedProject={pane.directory}
                            currentWorktree={pane.worktree}
                          />
                        }
                      >
                        {(_) => (
                          <SDKProvider directory={activeDirectory()!}>
                            <SyncProvider>
                              <PaneSyncedProviders paneId={pane.id} directory={activeDirectory()!}>
                                <SessionPane
                                  paneId={pane.id}
                                  directory={activeDirectory()!}
                                  projectDirectory={pane.directory}
                                  sessionId={pane.sessionId!}
                                  isFocused={isFocused}
                                  worktree={pane.worktree}
                                  onSessionChange={(sessionId: string | undefined) =>
                                    multiPane.updatePane(pane.id, { sessionId })
                                  }
                                  onDirectoryChange={(dir: string) =>
                                    multiPane.updatePane(pane.id, {
                                      directory: dir,
                                      sessionId: undefined,
                                      worktree: undefined,
                                    })
                                  }
                                  onWorktreeChange={(worktree) => multiPane.updatePane(pane.id, { worktree })}
                                  onClose={() => closePaneWithWorktreeCheck(pane.id)}
                                />
                              </PaneSyncedProviders>
                            </SyncProvider>
                          </SDKProvider>
                        )}
                      </Show>
                    )
                  }}
                />
                <DragOverlay>
                  <Show when={activeTitle()}>
                    {(title) => (
                      <div
                        class="pointer-events-none rounded-md border border-border-weak-base px-3 py-2 shadow-xs-border-base"
                        style={{ "background-color": dragOverlayBackground }}
                      >
                        <div class="text-12-medium text-text-strong">{title()}</div>
                        <Show when={activeProject()}>
                          {(project) => <div class="text-11-regular text-text-weak">{project()}</div>}
                        </Show>
                      </div>
                    )}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>
          <GlobalPromptWrapper />
        </Show>
      </div>
    </div>
  )
}

export default function MultiPanePage(props: MultiPanePageProps) {
  return <MultiPaneContent initialDir={props.initialDir} initialSession={props.initialSession} />
}
