import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { useMultiPane } from "@/context/multi-pane"
import { HomeScreen } from "@/components/home-screen"
import { usePreferredProject } from "@/hooks/use-preferred-project"

type PaneHomeProps = {
  paneId: string
  isFocused: () => boolean
  selectedProject?: string
  showBorder?: boolean
}

export function PaneHome(props: PaneHomeProps) {
  const multiPane = useMultiPane()
  const preferredProject = usePreferredProject()
  const [autoSelected, setAutoSelected] = createSignal(false)

  const hideLogo = createMemo(() => multiPane.panes().length > 1)
  const showRelativeTime = createMemo(() => multiPane.panes().length <= 1)
  const showThemePicker = createMemo(() => multiPane.panes().length === 1)
  const showBorder = createMemo(() => props.showBorder ?? multiPane.panes().length > 1)

  function updatePane(directory: string) {
    multiPane.updatePane(props.paneId, { directory, sessionId: undefined })
    multiPane.setFocused(props.paneId)
  }

  createEffect(() => {
    if (props.selectedProject !== undefined) return
    if (autoSelected()) return
    if (!props.isFocused()) return
    const candidate = preferredProject()
    if (!candidate) return
    setAutoSelected(true)
    updatePane(candidate)
  })

  function handleProjectSelected(directory: string) {
    updatePane(directory)
  }

  function handleNavigateMulti() {
    multiPane.addPane()
  }

  function handleMouseDown(event: MouseEvent) {
    const target = event.target as HTMLElement
    const isInteractive = target.closest('button, input, select, textarea, [contenteditable], [role="button"]')
    if (!isInteractive) {
      multiPane.setFocused(props.paneId)
    }
  }

  return (
    <div
      class="relative size-full flex flex-col overflow-hidden transition-all duration-150"
      style={{
        opacity: multiPane.panes().length > 1 && !props.isFocused() ? 0.5 : 1,
      }}
      onMouseDown={handleMouseDown}
    >
      <Show when={showBorder()}>
        <div
          class="pointer-events-none absolute inset-0 z-30 border"
          classList={{
            "border-border-accent-base": props.isFocused(),
            "border-border-strong-base": !props.isFocused(),
          }}
        />
      </Show>
      <HomeScreen
        selectedProject={props.selectedProject}
        hideLogo={hideLogo()}
        showRelativeTime={showRelativeTime()}
        showThemePicker={showThemePicker()}
        onProjectSelected={handleProjectSelected}
        onNavigateMulti={handleNavigateMulti}
      />
    </div>
  )
}
