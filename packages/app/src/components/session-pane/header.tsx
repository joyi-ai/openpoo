import { Show, createMemo, type Accessor } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { useMultiPane } from "@/context/multi-pane"
import { truncateDirectoryPrefix } from "@opencode-ai/util/path"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { makeViewKey } from "@/utils/layout-key"

export interface SessionPaneHeaderProps {
  directory: string
  projectDirectory?: string
  sessionId?: string
  paneId?: string
  isFocused?: Accessor<boolean>
  onSessionChange?: (sessionId: string | undefined) => void
  onDirectoryChange?: (directory: string) => void
  onClose?: () => void
}

export function SessionPaneHeader(props: SessionPaneHeaderProps) {
  const layout = useLayout()
  const sync = useSync()

  const sessions = createMemo(() => (sync.data.session ?? []).filter((s) => !s.parentID))
  const currentSession = createMemo(() => sessions().find((s) => s.id === props.sessionId))
  const branch = createMemo(() => sync.data.vcs?.branch)
  const focused = createMemo(() => props.isFocused?.() ?? true)
  const currentDirectory = createMemo(() => props.projectDirectory ?? props.directory)
  const viewKey = createMemo(() => makeViewKey({ paneId: props.paneId, directory: props.directory }))
  const view = createMemo(() => layout.view(viewKey()))

  function navigateToProject(directory: string | undefined) {
    if (!directory) return
    queueMicrotask(() => {
      props.onDirectoryChange?.(directory)
    })
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    queueMicrotask(() => {
      props.onSessionChange?.(session.id)
    })
  }

  const multiPane = useMultiPane()

  // Header (compact overlay)
  return (
    <header
      class="shrink-0 bg-background-stronger border-b flex flex-col"
      classList={{
        "border-border-accent-base": focused(),
        "border-border-weak-base": !focused(),
      }}
    >
      <div class="h-8 flex items-center px-2 gap-1">
        <div class="flex items-center gap-1 min-w-0 flex-1">
          <Select
            options={layout.projects.list().map((project) => project.worktree)}
            current={currentDirectory()}
            label={(x) => {
              const truncated = truncateDirectoryPrefix(x)
              const b = x === sync.directory ? branch() : undefined
              return b ? `${truncated}:${b}` : truncated
            }}
            onSelect={navigateToProject}
            class="text-12-regular text-text-base"
            variant="ghost"
          />
          <div class="text-text-weaker text-12-regular">/</div>
          <Select
            options={sessions()}
            current={currentSession()}
            placeholder="New"
            label={(x) => x.title}
            value={(x) => x.id}
            onSelect={navigateToSession}
            class="text-12-regular text-text-base max-w-[160px]"
            variant="ghost"
          />
        </div>
        <div class="flex items-center">
          <Show when={currentSession()}>
            <Tooltip value="New session">
              <IconButton icon="edit-small-2" variant="ghost" onClick={() => props.onSessionChange?.(undefined)} />
            </Tooltip>
          </Show>
          <Tooltip value="Toggle terminal">
            <IconButton
              icon={view().terminal.opened() ? "layout-bottom-full" : "layout-bottom"}
              variant="ghost"
              onClick={view().terminal.toggle}
            />
          </Tooltip>
          <Show when={multiPane.panes().length > 1 || !!props.sessionId}>
            <Tooltip value="Close pane">
              <IconButton icon="close" variant="ghost" onClick={props.onClose} />
            </Tooltip>
          </Show>
        </div>
      </div>
    </header>
  )
}
