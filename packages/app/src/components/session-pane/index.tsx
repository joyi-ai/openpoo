import { For, Show, createMemo, createEffect, on, onMount, onCleanup, createSignal, untrack, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useParams, useNavigate } from "@solidjs/router"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { SessionTodoFooter } from "@opencode-ai/ui/session-todo-footer"
import { SessionMessageRail } from "@opencode-ai/ui/session-message-rail"
import { Icon } from "@opencode-ai/ui/icon"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
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
import { SessionPaneHeader } from "./header"
import { ReviewPanel } from "./review-panel"
import { ContextTab } from "./context-tab"
import { MobileView } from "./mobile-view"
import { base64Decode } from "@opencode-ai/util/encode"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { useNotification } from "@/context/notification"
import { Persist, persisted } from "@/utils/persist"
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

type SessionSetup = {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  modeId?: string
  thinking?: boolean
}

type SessionSetupStore = {
  entries: Record<string, SessionSetup>
  used: Record<string, number>
}

const MAX_SESSION_SETUP = 50

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
  const hasMultiplePanes = createMemo(() =>
    props.mode === "multi" && multiPane ? multiPane.panes().length > 1 : false,
  )

  // Local state
  const [store, setStore] = createStore({
    stepsExpanded: {} as Record<string, boolean>,
    userInteracted: false,
    activeDraggable: undefined as string | undefined,
    turnLimit: 30,
    didRestoreScroll: {} as Record<string, boolean>,
    loadingMore: false,
    pendingTopScrollId: undefined as string | undefined,
    pendingTopScrollCanceled: false,
    pendingTopScrollFrame: undefined as number | undefined,
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

  // Todos
  const todos = createMemo(() => {
    const id = sessionId()
    return id ? (sync.data.todo[id] ?? []) : []
  })

  // Session messages hook
  const sessionMessages = useSessionMessages({
    sessionId,
  })

  const [setupStore, setSetupStore, _, setupReady] = persisted(
    Persist.global("session-setup", ["session-setup.v1"]),
    createStore<SessionSetupStore>({
      entries: {},
      used: {},
    }),
  )
  const [activeSetupKey, setActiveSetupKey] = createSignal<string | undefined>(undefined)
  const [restoringSetup, setRestoringSetup] = createSignal(false)
  const [pendingSetupRestore, setPendingSetupRestore] = createSignal(false)

  const setupKey = createMemo(() => {
    const id = sessionId()
    if (!id) return undefined
    const directory = props.directory || sync.directory
    if (!directory) return undefined
    return `${directory}:${id}`
  })

  function pruneSetupStore() {
    const keys = Object.keys(setupStore.entries)
    if (keys.length <= MAX_SESSION_SETUP) return
    const ordered = keys.slice().sort((a, b) => (setupStore.used[b] ?? 0) - (setupStore.used[a] ?? 0))
    const drop = ordered.slice(MAX_SESSION_SETUP)
    if (drop.length === 0) return
    setSetupStore(
      produce((draft) => {
        for (const key of drop) {
          delete draft.entries[key]
          delete draft.used[key]
        }
      }),
    )
  }

  function storeSetup(key: string, next: SessionSetup) {
    setSetupStore("entries", key, next)
    setSetupStore("used", key, Date.now())
    pruneSetupStore()
  }

  function snapshotSetup() {
    const currentAgent = local.agent.current()
    const currentModel = local.model.current()
    if (!currentAgent || !currentModel) return undefined
    return {
      agent: currentAgent.name,
      model: { providerID: currentModel.provider.id, modelID: currentModel.id },
      variant: local.model.variant.current(),
      modeId: local.mode.current()?.id,
      thinking: local.model.thinking.current(),
    }
  }

  function restoreSetup(setup: SessionSetup, key: string) {
    setRestoringSetup(true)
    if (setup.modeId) local.mode.set(setup.modeId)
    queueMicrotask(() => {
      if (activeSetupKey() !== key) {
        setRestoringSetup(false)
        return
      }
      if (setup.agent) local.agent.set(setup.agent)
      const model = setup.model
      if (model) local.model.set(model)
      if (model) local.model.variant.set(setup.variant)
      if (setup.thinking !== undefined) local.model.thinking.set(setup.thinking)
      setRestoringSetup(false)
    })
  }

  const renderedUserMessages = createMemo(() => {
    const messages = sessionMessages.visibleUserMessages()
    const limit = store.turnLimit
    if (limit <= 0) return []
    if (messages.length <= limit) return messages
    return messages.slice(messages.length - limit)
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
    if (!session) return

    const visible = renderedUserMessages()
    if (visible.length === 0) return

    const visibleIds = new Set(visible.map((m) => m.id))
    const messages = sync.data.message[session] ?? []
    for (const msg of messages) {
      if (msg.role === "user" && visibleIds.has(msg.id)) {
        void sync.session.ensureParts(session, msg.id)
        continue
      }

      if ("parentID" in msg && visibleIds.has(msg.parentID)) {
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
        if (!prevWorking) return
        const id = sessionMessages.lastUserMessage()?.id
        if (!id) return
        setStore("stepsExpanded", id, false)
      },
    ),
  )

  createEffect(
    on(
      () => [setupKey(), setupReady(), info()?.mode?.id] as const,
      ([key, ready, sessionModeId]) => {
        if (props.mode !== "single") return
        if (!ready) return
        setActiveSetupKey(key)
        setPendingSetupRestore(false)
        if (!key) return
        const id = sessionId()
        if (!id) return
        const cached = untrack(() => setupStore.entries[key])
        const modeId = cached?.modeId ?? sessionModeId
        if (cached) {
          restoreSetup({ ...cached, modeId }, key)
          return
        }
        const msg = untrack(() => sessionMessages.lastUserMessage())
        if (!msg) {
          const messages = sync.data.message[id]
          if (messages === undefined) {
            if (modeId) restoreSetup({ modeId }, key)
            setPendingSetupRestore(true)
            return
          }
          if (modeId) restoreSetup({ modeId }, key)
          return
        }
        const recovered: SessionSetup = {
          agent: msg.agent,
          model: msg.model,
          variant: msg.variant,
          modeId,
          thinking: msg.thinking,
        }
        restoreSetup(recovered, key)
        storeSetup(key, recovered)
      },
    ),
  )

  createEffect(
    on(
      () => sessionMessages.lastUserMessage()?.id,
      () => {
        if (props.mode !== "single") return
        if (!pendingSetupRestore()) return
        const key = setupKey()
        if (!key) return
        if (!setupReady()) return
        const cached = untrack(() => setupStore.entries[key])
        if (cached) {
          setPendingSetupRestore(false)
          return
        }
        const msg = sessionMessages.lastUserMessage()
        if (!msg) return
        const recovered: SessionSetup = {
          agent: msg.agent,
          model: msg.model,
          variant: msg.variant,
          modeId: info()?.mode?.id,
          thinking: msg.thinking,
        }
        restoreSetup(recovered, key)
        storeSetup(key, recovered)
        setPendingSetupRestore(false)
      },
    ),
  )

  createEffect(() => {
    if (props.mode !== "single") return
    const key = activeSetupKey()
    if (!key) return
    if (!setupReady()) return
    if (restoringSetup()) return
    if (pendingSetupRestore()) return
    const next = snapshotSetup()
    if (!next) return
    storeSetup(key, next)
  })

  createEffect(() => {
    if (props.mode !== "single") return
    if (!pendingSetupRestore()) return
    const id = sessionId()
    if (!id) return
    const messages = sync.data.message[id]
    if (messages === undefined) return
    if (messages.length > 0) return
    setPendingSetupRestore(false)
  })

  // Reset user interaction on session change
  createEffect(
    on(
      () => sessionId(),
      () => {
        setStore("userInteracted", false)
      },
    ),
  )

  createEffect(
    on(
      () => sessionId(),
      (id) => {
        if (!id) return
        setStore("turnLimit", 30)
      },
      { defer: true },
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
    onToggleSteps: () => {
      const id = sessionMessages.activeMessage()?.id
      if (!id) return
      setStore("stepsExpanded", id, (x) => !x)
    },
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

  const desktopAutoScroll = createAutoScroll({
    working,
    onUserInteracted: () => {
      setStore("userInteracted", true)
    },
  })

  const handleUserScrollIntent = () => {
    if (!store.pendingTopScrollId) return
    setStore("pendingTopScrollCanceled", true)
  }

  let scrollIntentCleanup: (() => void) | undefined

  let desktopScrollEl: HTMLDivElement | undefined
  const setDesktopScrollRef = (el: HTMLDivElement | undefined) => {
    if (scrollIntentCleanup) {
      scrollIntentCleanup()
      scrollIntentCleanup = undefined
    }

    desktopScrollEl = el
    desktopAutoScroll.scrollRef(el)
    requestAnimationFrame(() => restoreDesktopScroll())

    if (!el) return

    el.addEventListener("wheel", handleUserScrollIntent, { passive: true })
    el.addEventListener("pointerdown", handleUserScrollIntent)
    el.addEventListener("touchstart", handleUserScrollIntent, { passive: true })

    scrollIntentCleanup = () => {
      el.removeEventListener("wheel", handleUserScrollIntent)
      el.removeEventListener("pointerdown", handleUserScrollIntent)
      el.removeEventListener("touchstart", handleUserScrollIntent)
    }
  }

  const restoreDesktopScroll = (retries = 0) => {
    const root = desktopScrollEl
    if (!root) return

    const key = sessionKey()
    if (store.didRestoreScroll[key]) return
    if (renderedUserMessages().length === 0) return

    // Wait for content to be scrollable - content may not have rendered yet
    if (root.scrollHeight <= root.clientHeight && retries < 10) {
      requestAnimationFrame(() => restoreDesktopScroll(retries + 1))
      return
    }

    // Always open sessions at the bottom
    desktopAutoScroll.forceScrollToBottom()
    setStore("didRestoreScroll", key, true)
  }

  createEffect(
    on(
      () => renderedUserMessages().length,
      () => {
        requestAnimationFrame(() => restoreDesktopScroll())
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (scrollIntentCleanup) scrollIntentCleanup()

    const pending = store.pendingTopScrollFrame
    if (!pending) return
    cancelAnimationFrame(pending)
  })

  const scrollToMessage = (
    id: string,
    behavior: ScrollBehavior = "smooth",
    block: ScrollLogicalPosition = "center",
  ) => {
    const root = desktopScrollEl
    if (!root) return

    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id.replaceAll('"', '\\"')

    const el = root.querySelector(`[data-message="${escaped}"]`) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ block, behavior })
  }

  const scheduleScrollToMessageTop = (id: string) => {
    if (!desktopScrollEl) return

    const pending = store.pendingTopScrollFrame
    if (pending) cancelAnimationFrame(pending)

    setStore({
      pendingTopScrollId: id,
      pendingTopScrollCanceled: false,
      pendingTopScrollFrame: undefined,
    })

    const frame = requestAnimationFrame(() => {
      if (store.pendingTopScrollId !== id) return

      if (store.pendingTopScrollCanceled) {
        setStore({
          pendingTopScrollId: undefined,
          pendingTopScrollCanceled: false,
          pendingTopScrollFrame: undefined,
        })
        return
      }

      scrollToMessage(id, "smooth", "start")
      desktopAutoScroll.handleInteraction()
      setStore({
        pendingTopScrollId: undefined,
        pendingTopScrollCanceled: false,
        pendingTopScrollFrame: undefined,
      })
    })

    setStore("pendingTopScrollFrame", frame)
  }

  // Reset message ID when new message arrives
  createEffect(
    on(
      () => sessionMessages.visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (!lastId) return
        if (!prevLastId) return
        if (lastId <= prevLastId) return
        sessionMessages.resetToLast()
        scheduleScrollToMessageTop(lastId)
      },
      { defer: true },
    ),
  )

  const handleMessageSelect = (message: UserMessage) => {
    const visible = sessionMessages.visibleUserMessages()
    const index = visible.findIndex((m) => m.id === message.id)
    const needed = index === -1 ? 0 : visible.length - index
    const expandsWindow = needed > store.turnLimit
    if (expandsWindow) setStore("turnLimit", needed + 5)

    sessionMessages.setActiveMessage(message)

    const last = sessionMessages.lastUserMessage()?.id
    if (last && message.id === last) {
      desktopAutoScroll.forceScrollToBottom()
      return
    }

    if (expandsWindow) {
      setTimeout(() => scrollToMessage(message.id), 0)
      return
    }

    scrollToMessage(message.id)
  }

  createEffect(
    on(
      () => sessionMessages.activeMessage()?.id,
      (id, prev) => {
        if (!id) return
        if (!prev) return
        if (id === prev) return
        if (working()) return
        scrollToMessage(id)
      },
      { defer: true },
    ),
  )

  const handleDesktopScroll = () => {
    desktopAutoScroll.handleScroll()

    const root = desktopScrollEl
    const id = sessionId()
    if (!root) return
    if (!id) return

    if (store.loadingMore) return
    if (root.scrollTop > 200) return

    const visible = sessionMessages.visibleUserMessages()
    const beforeHeight = root.scrollHeight
    const beforeTop = root.scrollTop

    if (store.turnLimit < visible.length) {
      setStore("turnLimit", (x) => Math.min(visible.length, x + 20))
      requestAnimationFrame(() => {
        const afterHeight = root.scrollHeight
        root.scrollTop = beforeTop + (afterHeight - beforeHeight)
      })
      return
    }

    if (!sync.session.history.more(id)) return
    if (sync.session.history.loading(id)) return

    setStore("loadingMore", true)
    void sync.session.history
      .loadMore(id, 50)
      .then(() => {
        setStore("turnLimit", (x) => x + 50)
        requestAnimationFrame(() => {
          const afterHeight = root.scrollHeight
          root.scrollTop = beforeTop + (afterHeight - beforeHeight)
        })
      })
      .finally(() => {
        setStore("loadingMore", false)
      })
  }

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
      <div class="flex items-stretch justify-start h-full min-h-0">
        <SessionMessageRail
          messages={sessionMessages.visibleUserMessages()}
          current={sessionMessages.activeMessage()}
          onMessageSelect={handleMessageSelect}
          wide={!showTabs()}
        />
        <div
          ref={setDesktopScrollRef}
          onScroll={handleDesktopScroll}
          onClick={desktopAutoScroll.handleInteraction}
          class={`${sessionTurnPadding()} flex-1 min-w-0 min-h-0 overflow-y-auto no-scrollbar`}
        >
          <div class="flex min-h-full flex-col">
            <div ref={desktopAutoScroll.contentRef} class="flex flex-col gap-12">
              <For each={renderedUserMessages()}>
                {(message) => (
                  <SessionTurn
                    sessionID={sessionId()!}
                    messageID={message.id}
                    lastUserMessageID={sessionMessages.lastUserMessage()?.id}
                    stepsExpanded={store.stepsExpanded[message.id] ?? false}
                    onStepsExpandedToggle={() => setStore("stepsExpanded", message.id, (x) => !x)}
                    onUserInteracted={() => setStore("userInteracted", true)}
                    actions={{
                      onEdit: messageActions.editMessage,
                      onRestore: messageActions.restoreCheckpoint,
                      onRetry: messageActions.retryMessage,
                      onDelete: messageActions.deleteMessage,
                    }}
                    classes={{
                      root: "min-w-0 w-full relative !h-auto",
                      content: "flex flex-col justify-between !overflow-visible !h-auto",
                      container:
                        "w-full " +
                        (!showTabs()
                          ? "max-w-200 mx-auto px-6"
                          : sessionMessages.visibleUserMessages().length > 1
                            ? "pr-6 pl-18"
                            : "px-6"),
                    }}
                  />
                )}
              </For>
            </div>
            {/* Spacer to prevent content from being hidden behind sticky todo footer */}
            <Show when={todos().some((t) => t.status !== "completed")}>
              <div class="h-50 shrink-0" />
            </Show>
            <div class="mt-auto">
              {/* Todo footer - sticky at bottom, hides when all complete */}
              <SessionTodoFooter todos={todos()} />
            </div>
          </div>
        </div>
      </div>
    </Show>
  )

  // Multi mode container styles
  const multiContainerClass = () =>
    props.mode === "multi"
      ? "relative size-full flex flex-col overflow-hidden transition-all duration-150"
      : "relative size-full overflow-hidden flex flex-col transition-all duration-150"

  const multiContainerStyle = () =>
    props.mode === "multi" && hasMultiplePanes() && !isFocused() ? { opacity: 0.5 } : undefined

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
      style={multiContainerStyle()}
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
            onRestore: messageActions.restoreCheckpoint,
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
