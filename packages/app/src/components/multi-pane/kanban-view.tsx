import { For, Show, createMemo } from "solid-js"
import { Portal } from "solid-js/web"
import { useMultiPane, type PaneConfig } from "@/context/multi-pane"
import { useGlobalSync } from "@/context/global-sync"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { useNotification } from "@/context/notification"
import { DataProvider } from "@opencode-ai/ui/context"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Spinner } from "@opencode-ai/ui/spinner"
import { DragDropProvider } from "@thisbeyond/solid-dnd"
import { SessionPane } from "@/components/session-pane"
import { MultiPanePromptPanel } from "./prompt-panel"
import { PaneHome } from "./pane-home"
import { getPaneProjectLabel, getPaneState, getPaneTitle, getPaneWorking } from "@/utils/pane"
import { useRadialDial } from "@/hooks/use-radial-dial"
import { RadialDialMenu } from "@opencode-ai/ui/radial-dial-menu"

type Column = {
  id: string
  title: string
  panes: PaneConfig[]
  groups: ColumnGroup[]
  canAdd: boolean
}

type ColumnGroup = {
  id: string
  title: string
  panes: PaneConfig[]
}

function groupByProject(panes: PaneConfig[]) {
  const groups = new Map<string, ColumnGroup>()
  for (const pane of panes) {
    const key = pane.directory ?? "__no_project__"
    const title = getPaneProjectLabel(pane) ?? "No project"
    const existing = groups.get(key)
    if (existing) {
      existing.panes.push(pane)
      continue
    }
    groups.set(key, { id: key, title, panes: [pane] })
  }
  return Array.from(groups.values())
}

function PaneCard(props: { pane: PaneConfig }) {
  const multiPane = useMultiPane()
  const globalSync = useGlobalSync()

  const focused = createMemo(() => multiPane.focusedPaneId() === props.pane.id)

  const title = createMemo(() => getPaneTitle(props.pane, globalSync) ?? "New session")
  const subtitle = createMemo(() => getPaneProjectLabel(props.pane) ?? "No project")
  const working = createMemo(() => getPaneWorking(props.pane, globalSync))

  return (
    <button
      type="button"
      class="group flex flex-col gap-1 w-full rounded-md border px-3 py-2 text-left shadow-xs-border-base transition-colors"
      classList={{
        "border-border-accent-base bg-surface-raised-base-active": focused(),
        "border-border-weak-base bg-surface-raised-base hover:bg-surface-raised-base-hover": !focused(),
      }}
      onMouseDown={(event) => {
        if (event.button !== 2) return
        multiPane.setFocused(props.pane.id)
      }}
      onClick={() => multiPane.setFocused(props.pane.id)}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-13-medium text-text-strong truncate">{title()}</div>
        </div>
        <Show when={working()}>
          <Spinner class="size-3 mt-0.5 shrink-0" />
        </Show>
      </div>
      <div class="text-11-regular text-text-weak truncate">{subtitle()}</div>
    </button>
  )
}

function PaneColumns(props: { panes: PaneConfig[] }) {
  const multiPane = useMultiPane()
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const focusedPaneId = createMemo(() => multiPane.focusedPaneId())

  const columns = createMemo<Column[]>(() => {
    const fresh: PaneConfig[] = []
    const inProgress: PaneConfig[] = []
    const inReview: PaneConfig[] = []
    const done: PaneConfig[] = []

    for (const pane of props.panes) {
      const sessionId = pane.sessionId
      const directory = pane.directory

      if (!sessionId || !directory) {
        fresh.push(pane)
        continue
      }

      const [store] = globalSync.child(directory)
      const status = store.session_status[sessionId]
      if (status?.type === "busy" || status?.type === "retry") {
        inProgress.push(pane)
        continue
      }

      const unseen = notification.session.unseen(sessionId)
      if (unseen.length > 0) {
        inReview.push(pane)
        continue
      }

      done.push(pane)
    }

    return [
      { id: "new", title: "New", panes: fresh, canAdd: true },
      { id: "in-progress", title: "In progress", panes: inProgress, canAdd: true },
      { id: "in-review", title: "In review", panes: inReview, canAdd: false },
      { id: "done", title: "Done", panes: done, canAdd: false },
    ].map((col) => ({ ...col, groups: groupByProject(col.panes) }))
  })

  function addToColumn(directory: string | undefined) {
    const focused = multiPane.focusedPane()
    const fallback = focused?.directory
    multiPane.addPane(directory ?? fallback)
  }

  return (
    <div class="flex-1 min-w-0 min-h-0 overflow-x-auto overflow-y-hidden">
      <div class="h-full flex items-stretch gap-4 p-4">
        <For each={columns()}>
          {(col) => {
            const active = createMemo(() => col.panes.some((pane) => pane.id === focusedPaneId()))
            return (
              <div class="w-72 shrink-0 flex flex-col min-h-0">
                <div class="flex items-center justify-between px-1 pb-2">
                  <div class="text-11-medium text-text-weak uppercase tracking-wide">{col.title}</div>
                  <Show when={col.canAdd}>
                    <Tooltip value="New tab" placement="bottom">
                      <IconButton icon="plus" variant="ghost" onClick={() => addToColumn(undefined)} />
                    </Tooltip>
                  </Show>
                </div>
                <div
                  class="flex-1 min-h-0 border p-2 overflow-y-auto no-scrollbar flex flex-col gap-3"
                  classList={{
                    "border-border-accent-base": active(),
                    "border-border-strong-base": !active(),
                  }}
                >
                  <For each={col.groups}>
                    {(group) => (
                      <div class="flex flex-col gap-2">
                        <div class="px-1 text-10-medium text-text-weak uppercase tracking-wide">{group.title}</div>
                        <For each={group.panes}>{(pane) => <PaneCard pane={pane} />}</For>
                      </div>
                    )}
                  </For>
                  <Show when={col.id === "new" && col.panes.length === 0}>
                    <button
                      type="button"
                      class="w-full rounded-md border border-dashed border-border-weak-base px-3 py-2 text-left text-12-medium text-text-weak shadow-xs-border-base transition-colors hover:bg-surface-raised-base-hover"
                      onClick={() => addToColumn(undefined)}
                    >
                      Create session
                    </button>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

function SidePanelSynced(props: { paneId: string; directory: string; sessionId?: string }) {
  const multiPane = useMultiPane()
  const sync = useSync()
  const sdk = useSDK()
  const respondToPermission = (input: { sessionID: string; permissionID: string; response: "once" | "always" | "reject" }) =>
    sdk.client.permission.respond(input)

  const respondToAskUser = async (input: { requestID: string; answers: Record<string, string> }) => {
    const response = await fetch(`${sdk.url}/askuser/${input.requestID}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": props.directory,
      },
      body: JSON.stringify({ answers: input.answers }),
    })
    return response.json()
  }

  const respondToPlanMode = async (input: { requestID: string; approved: boolean }) => {
    const response = await fetch(`${sdk.url}/planmode/${input.requestID}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": props.directory,
      },
      body: JSON.stringify({ approved: input.approved }),
    })
    return response.json()
  }

  const isFocused = createMemo(() => multiPane.focusedPaneId() === props.paneId)

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onPermissionRespond={respondToPermission}
      onAskUserRespond={respondToAskUser}
      onPlanModeRespond={respondToPlanMode}
    >
      <LocalProvider>
        <TerminalProvider paneId={props.paneId}>
          <FileProvider>
            <PromptProvider paneId={props.paneId}>
              <div class="flex-1 min-h-0 flex flex-col">
                <div class="flex-1 min-h-0 overflow-hidden">
                  <DragDropProvider>
                    <SessionPane
                      mode="multi"
                      paneId={props.paneId}
                      directory={props.directory}
                      sessionId={props.sessionId}
                      isFocused={isFocused}
                      reviewMode="global"
                      onSessionChange={(sessionId: string | undefined) =>
                        multiPane.updatePane(props.paneId, { sessionId })
                      }
                      onDirectoryChange={(dir: string) =>
                        multiPane.updatePane(props.paneId, { directory: dir, sessionId: undefined })
                      }
                      onClose={() => multiPane.removePane(props.paneId)}
                    />
                  </DragDropProvider>
                </div>
                <MultiPanePromptPanel paneId={props.paneId} sessionId={props.sessionId} />
              </div>
            </PromptProvider>
          </FileProvider>
        </TerminalProvider>
      </LocalProvider>
    </DataProvider>
  )
}

function PaneSidePanel() {
  const multiPane = useMultiPane()
  const focused = createMemo(() => multiPane.focusedPane())

  return (
    <div
      class="shrink-0 h-full border-l border-border-weak-base bg-background-base flex flex-col min-h-0"
      style={{ width: "clamp(360px, 38vw, 560px)" }}
    >
      <Show
        when={focused()}
        fallback={
          <div class="flex-1 min-h-0 flex items-center justify-center text-text-weak text-12-regular">Select a tab</div>
        }
      >
        {(pane) => (
          <Show
            when={getPaneState(pane()) === "session"}
            fallback={
              <PaneHome
                paneId={pane().id}
                isFocused={() => multiPane.focusedPaneId() === pane().id}
                selectedProject={pane().directory}
                showBorder={false}
              />
            }
          >
            {(_) => (
              <SDKProvider directory={pane().directory!}>
                <SyncProvider>
                  <SidePanelSynced paneId={pane().id} directory={pane().directory!} sessionId={pane().sessionId!} />
                </SyncProvider>
              </SDKProvider>
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}

export function MultiPaneKanbanView(props: { panes: PaneConfig[] }) {
  const multiPane = useMultiPane()
  const radialDial = useRadialDial({
    onAction: (action) => {
      const focusedId = multiPane.focusedPaneId()
      const focusedPane = multiPane.focusedPane()
      switch (action) {
        case "new":
          multiPane.addPane(focusedPane?.directory)
          return
        case "close":
          if (focusedId) multiPane.removePane(focusedId)
          return
        case "clone":
          if (focusedId) {
            void multiPane.clonePane(focusedId)
          }
          return
        case "expand":
          if (focusedId) {
            multiPane.toggleMaximize(focusedId)
          }
          return
      }
    },
  })

  return (
    <div
      class="flex-1 min-h-0 flex"
      onMouseDown={radialDial.handlers.onMouseDown}
      onMouseMove={radialDial.handlers.onMouseMove}
      onMouseUp={radialDial.handlers.onMouseUp}
      onContextMenu={radialDial.handlers.onContextMenu}
    >
      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        <PaneColumns panes={props.panes} />
      </div>
      <PaneSidePanel />
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
