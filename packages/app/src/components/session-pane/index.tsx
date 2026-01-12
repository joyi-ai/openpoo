import { Show, createMemo, createEffect, on, onMount, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams, useNavigate } from "@solidjs/router"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { SessionMessageRail } from "@opencode-ai/ui/session-message-rail"
import { Icon } from "@opencode-ai/ui/icon"
import { DateTime } from "luxon"
import { createDraggable, createDroppable } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLayout } from "@/context/layout"
import { useMultiPane } from "@/context/multi-pane"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useHeaderOverlay } from "@/hooks/use-header-overlay"
import { useSessionMessages } from "@/hooks/use-session-messages"
import { useSessionSync } from "@/hooks/use-session-sync"
import { useSessionCommands } from "@/hooks/use-session-commands"
import { useMessageActions } from "@/hooks/use-message-actions"
import { ThemeDropup } from "@/components/theme-dropup"
import { useTheme } from "@opencode-ai/ui/theme"
import { SessionPaneHeader } from "./header"
import { ReviewPanel } from "./review-panel"
import { ContextTab } from "./context-tab"
import { MobileView } from "./mobile-view"
import { base64Decode } from "@opencode-ai/util/encode"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { useNotification } from "@/context/notification"
import type { UserMessage } from "@opencode-ai/sdk/v2"

export type SessionPaneMode = "single" | "multi"

export interface SessionPaneProps {
  mode: SessionPaneMode
  paneId?: string
  directory: string
  sessionId?: string
  isFocused?: Accessor<boolean>
  onSessionChange?: (sessionId: string | undefined) => void
  onDirectoryChange?: (directory: string) => void
  onClose?: () => void
  promptInputRef?: Accessor<HTMLDivElement | undefined>
  reviewMode?: "pane" | "global"
}

export function SessionPane(props: SessionPaneProps) {
  const params = useParams()
  const navigate = useNavigate()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const layout = useLayout()
  const dialog = useDialog()
  const multiPane = props.mode === "multi" ? useMultiPane() : undefined
  const notification = useNotification()
  const messageActions = useMessageActions()
  const theme = useTheme()
  const hasMultiplePanes = createMemo(() =>
    props.mode === "multi" && multiPane ? multiPane.panes().length > 1 : false,
  )

  // Local state
  const [store, setStore] = createStore({
    stepsExpanded: false,
    userInteracted: false,
    activeDraggable: undefined as string | undefined,
  })

  // Session ID (from props in multi mode, from params in single mode)
  const sessionId = createMemo(() => (props.mode === "single" ? params.id : props.sessionId))

  // Directory matching
  const expectedDirectory = createMemo(() =>
    props.mode === "single" ? (params.dir ? base64Decode(params.dir) : "") : props.directory,
  )
  const sdkDirectoryMatches = createMemo(() => expectedDirectory() !== "" && sdk.directory === expectedDirectory())

  // Session key for tabs
  const sessionKey = createMemo(() =>
    props.mode === "single"
      ? `${params.dir}${params.id ? "/" + params.id : ""}`
      : `multi-${props.paneId}-${props.directory}${props.sessionId ? "/" + props.sessionId : ""}`,
  )

  // Tab management
  const tabs = createMemo(() => layout.tabs(sessionKey()))
  const view = createMemo(() => layout.view(sessionKey()))

  // Session info
  const info = createMemo(() => {
    const id = sessionId()
    return id ? sync.session.get(id) : undefined
  })

  // Diffs
  const diffs = createMemo(() => {
    const id = sessionId()
    return id ? (sync.data.session_diff[id] ?? []) : []
  })

  // Session messages hook
  const sessionMessages = useSessionMessages({
    sessionId,
  })

  // Focus state
  const isFocused = createMemo(() => props.isFocused?.() ?? true)

  // Header overlay hook (only for multi mode)
  const headerOverlay = useHeaderOverlay({
    mode: props.mode === "multi" ? "overlay" : "scroll",
    isFocused,
  })
  const paneDraggable = props.mode === "multi" && props.paneId ? createDraggable(props.paneId) : undefined
  const paneDroppable = props.mode === "multi" && props.paneId ? createDroppable(props.paneId) : undefined
  const paneDragHandlers = paneDraggable ? paneDraggable.dragActivators : {}

  // Session sync hook
  useSessionSync({
    sessionId,
    directoryMatches: sdkDirectoryMatches,
    onNotFound: props.mode === "single" ? () => navigate(`/${params.dir}/session`, { replace: true }) : undefined,
  })

  // Status
  const idle = { type: "idle" as const }
  const status = createMemo(() => sync.data.session_status[sessionId() ?? ""] ?? idle)
  const working = createMemo(
    () => status().type !== "idle" && sessionMessages.activeMessage()?.id === sessionMessages.lastUserMessage()?.id,
  )

  createEffect(() => {
    const session = sessionId()
    const active = sessionMessages.activeMessage()
    if (!session) return
    if (!active) return
    const messages = sync.data.message[session] ?? []
    for (const msg of messages) {
      if (msg.id === active.id) {
        void sync.session.ensureParts(session, msg.id)
      }
      if ("parentID" in msg && msg.parentID === active.id) {
        void sync.session.ensureParts(session, msg.id)
      }
    }
  })

  createEffect(
    on(
      () => working(),
      (isWorking, prevWorking) => {
        if (props.mode !== "multi") return
        if (isWorking) return
        if (prevWorking) setStore("stepsExpanded", false)
      },
    ),
  )

  // Sync agent/model from last message
  createEffect(
    on(
      () => sessionMessages.lastUserMessage()?.id,
      () => {
        const msg = sessionMessages.lastUserMessage()
        if (!msg) return
        if (msg.agent) local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model)
      },
    ),
  )

  // Reset message ID when new message arrives
  createEffect(
    on(
      () => sessionMessages.visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          sessionMessages.resetToLast()
        }
      },
      { defer: true },
    ),
  )

  // Reset user interaction on session change
  createEffect(
    on(
      () => sessionId(),
      () => {
        setStore("userInteracted", false)
      },
    ),
  )

  createEffect(() => {
    if (props.mode !== "multi") return
    if (!isFocused()) return
    const id = sessionId()
    if (!id) return
    notification.session.markViewed(id)
  })

  // Session commands (only if enabled/focused)
  useSessionCommands({
    sessionId,
    sessionKey,
    isEnabled: props.mode === "multi" ? isFocused : () => true,
    onNavigateMessage: sessionMessages.navigateByOffset,
    onToggleSteps: () => setStore("stepsExpanded", (x) => !x),
    onResetMessageToLast: sessionMessages.resetToLast,
    setActiveMessage: (msg) => sessionMessages.setActiveMessage(msg as UserMessage | undefined),
    userMessages: sessionMessages.userMessages,
    visibleUserMessages: sessionMessages.visibleUserMessages,
  })

  // Auto-focus input on keydown (single mode only)
  const handleKeyDown = (event: KeyboardEvent) => {
    if (props.mode !== "single") return
    const activeElement = document.activeElement as HTMLElement | undefined
    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(activeElement.tagName) || activeElement.isContentEditable
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    const inputRef = props.promptInputRef?.()
    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      inputRef?.focus()
    }
  }

  onMount(() => {
    if (props.mode === "single") {
      document.addEventListener("keydown", handleKeyDown)
    }
  })

  onCleanup(() => {
    if (props.mode === "single") {
      document.removeEventListener("keydown", handleKeyDown)
    }
  })

  // Computed: show tabs panel
  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const allowLocalReview = createMemo(() => props.reviewMode !== "global")
  const showTabs = createMemo(
    () =>
      allowLocalReview() &&
      view().reviewPanel.opened() &&
      (diffs().length > 0 || tabs().all().length > 0 || contextOpen()),
  )

  const sessionTurnPadding = createMemo(() => (props.mode === "single" ? "pb-20" : "pb-0"))

  // New session view
  const NewSessionView = () => (
    <div class="relative size-full flex flex-col pb-45 justify-end items-start gap-4 flex-[1_0_0] self-stretch max-w-200 mx-auto px-6">
      <div class="text-20-medium text-text-weaker">New session</div>
      <div class="flex justify-center items-center gap-3">
        <Icon name="folder" size="small" />
        <div class="text-12-medium text-text-weak">
          {getDirectory(sync.data.path.directory)}
          <span class="text-text-strong">{getFilename(sync.data.path.directory)}</span>
        </div>
      </div>
      <Show when={sync.project}>
        {(project) => (
          <div class="flex justify-center items-center gap-3">
            <Icon name="pencil-line" size="small" />
            <div class="text-12-medium text-text-weak">
              Last modified&nbsp;
              <span class="text-text-strong">
                {DateTime.fromMillis(project().time.updated ?? project().time.created).toRelative()}
              </span>
            </div>
          </div>
        )}
      </Show>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 pb-6">
        <div class="pointer-events-auto mx-auto w-full max-w-200 px-6 flex justify-end">
          <ThemeDropup />
        </div>
      </div>
    </div>
  )

  // Desktop session content
  const DesktopSessionContent = () => (
    <Show when={sessionId()} fallback={props.mode === "single" ? <NewSessionView /> : null}>
      <div class="flex items-start justify-start h-full min-h-0">
        <SessionMessageRail
          messages={sessionMessages.visibleUserMessages()}
          current={sessionMessages.activeMessage()}
          onMessageSelect={sessionMessages.setActiveMessage}
          wide={!showTabs()}
        />
        <Show when={sessionMessages.activeMessage()}>
          <SessionTurn
            sessionID={sessionId()!}
            messageID={sessionMessages.activeMessage()!.id}
            lastUserMessageID={sessionMessages.lastUserMessage()?.id}
            stepsExpanded={store.stepsExpanded}
            onStepsExpandedToggle={() => setStore("stepsExpanded", (x) => !x)}
            onUserInteracted={() => setStore("userInteracted", true)}
            actions={{
              onEdit: messageActions.editMessage,
              onRetry: messageActions.retryMessage,
              onDelete: messageActions.deleteMessage,
            }}
            classes={{
              root: `${sessionTurnPadding()} flex-1 min-w-0`,
              content: sessionTurnPadding(),
              container:
                "w-full " +
                (!showTabs()
                  ? "max-w-200 mx-auto px-6"
                  : sessionMessages.visibleUserMessages().length > 1
                    ? "pr-6 pl-18"
                    : "px-6"),
            }}
          />
        </Show>
      </div>
    </Show>
  )

  // Multi mode container styles
  const multiContainerClass = () =>
    props.mode === "multi"
      ? "relative size-full flex flex-col overflow-hidden transition-colors duration-150"
      : "relative size-full overflow-hidden flex flex-col transition-colors duration-150"

  const multiContainerClassList = () => ({
    "bg-background-base": props.mode === "single",
  })

  const handleMultiPaneMouseDown = (event: MouseEvent) => {
    if (props.mode !== "multi" || !props.paneId || !multiPane) return
    const target = event.target as HTMLElement
    const isInteractive = target.closest('button, input, select, textarea, [contenteditable], [role="button"]')
    if (!isInteractive) {
      multiPane.setFocused(props.paneId)
    }
  }

  function setContainerRef(el: HTMLDivElement) {
    headerOverlay.containerRef(el)
    if (paneDroppable) paneDroppable.ref(el)
  }

  function setHeaderDragRef(el: HTMLDivElement) {
    if (paneDraggable) paneDraggable.ref(el)
  }

  return (
    <div
      ref={setContainerRef}
      class={multiContainerClass()}
      classList={multiContainerClassList()}
      onMouseDown={props.mode === "multi" ? handleMultiPaneMouseDown : undefined}
      onMouseEnter={props.mode === "multi" ? headerOverlay.handleMouseEnter : undefined}
      onMouseLeave={props.mode === "multi" ? headerOverlay.handleMouseLeave : undefined}
      onMouseMove={props.mode === "multi" ? headerOverlay.handleMouseMove : undefined}
    >
      <Show when={props.mode === "multi" && hasMultiplePanes()}>
        <div
          class="pointer-events-none absolute inset-0 z-30 border"
          classList={{
            "border-border-accent-base": isFocused(),
            "border-border-strong-base": !isFocused(),
          }}
        />
      </Show>

      {/* Dim overlay for unfocused panels in multi-pane mode */}
      <Show when={props.mode === "multi" && !isFocused()}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            "z-index": 20,
            "background-color": theme.mode() === "light" ? "rgba(0, 0, 0, 0.05)" : "rgba(0, 0, 0, 0.1)",
            "pointer-events": "none",
          }}
        />
      </Show>

      {/* Header */}
      <Show when={props.mode === "single"}>
        <SessionPaneHeader mode="single" directory={props.directory} sessionId={sessionId()} isFocused={isFocused} />
      </Show>
      <Show when={props.mode === "multi"}>
        <div
          ref={setHeaderDragRef}
          class="absolute top-0 left-0 right-0 z-40 transition-opacity duration-150"
          classList={{
            "opacity-100 pointer-events-auto": headerOverlay.showHeader(),
            "opacity-0 pointer-events-none": !headerOverlay.showHeader(),
            "cursor-grab": !!paneDraggable,
            "cursor-grabbing": paneDraggable?.isActiveDraggable,
          }}
          {...paneDragHandlers}
          onMouseDown={(e) => {
            e.stopPropagation()
          }}
          onMouseEnter={() => headerOverlay.setIsOverHeader(true)}
          onMouseLeave={() => headerOverlay.setIsOverHeader(false)}
          onFocusIn={() => headerOverlay.setHeaderHasFocus(true)}
          onFocusOut={(e) => {
            const relatedTarget = e.relatedTarget as HTMLElement | null
            if (!e.currentTarget.contains(relatedTarget)) {
              headerOverlay.setHeaderHasFocus(false)
            }
          }}
        >
          <SessionPaneHeader
            mode="multi"
            paneId={props.paneId}
            directory={props.directory}
            sessionId={sessionId()}
            isFocused={isFocused}
            onSessionChange={props.onSessionChange}
            onDirectoryChange={props.onDirectoryChange}
            onClose={props.onClose}
          />
        </div>
      </Show>

      <div class="relative z-10 flex-1 min-h-0 flex flex-col">
        {/* Mobile view */}
        <MobileView
          sessionId={sessionId()}
          visibleUserMessages={sessionMessages.visibleUserMessages}
          lastUserMessage={sessionMessages.lastUserMessage}
          diffs={diffs}
          working={working}
          onUserInteracted={() => setStore("userInteracted", true)}
          messageActions={{
            onEdit: messageActions.editMessage,
            onRetry: messageActions.retryMessage,
            onDelete: messageActions.deleteMessage,
          }}
          newSessionView={NewSessionView}
        />

        {/* Desktop view */}
        <div class={props.mode === "single" ? "hidden md:flex min-h-0 grow w-full" : "flex-1 min-h-0 flex"}>
          <div
            class="@container relative shrink-0 py-3 flex flex-col gap-6 min-h-0 h-full"
            style={{
              width: showTabs() ? `${layout.session.width()}px` : "100%",
            }}
            classList={{
              "bg-background-stronger": props.mode === "single",
            }}
          >
            <div class="flex-1 min-h-0 overflow-hidden">
              <DesktopSessionContent />
            </div>
            <Show when={showTabs()}>
              <ResizeHandle
                direction="horizontal"
                size={layout.session.width()}
                min={450}
                max={window.innerWidth * 0.45}
                onResize={layout.session.resize}
              />
            </Show>
          </div>

          {/* Review panel */}
          <Show when={showTabs()}>
            <ReviewPanel
              sessionKey={sessionKey()}
              sessionId={sessionId()}
              diffs={diffs()}
              sessionInfo={info()}
              activeDraggable={store.activeDraggable}
              onDragStart={(id) => setStore("activeDraggable", id)}
              onDragEnd={() => setStore("activeDraggable", undefined)}
            />
          </Show>
        </div>
      </div>
    </div>
  )
}

export { SessionPaneHeader } from "./header"
export { ReviewPanel } from "./review-panel"
export { ContextTab } from "./context-tab"
export { MobileView } from "./mobile-view"
