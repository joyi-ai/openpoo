import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useMultiPane } from "@/context/multi-pane"
import { useLayout } from "@/context/layout"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { usePrompt, type Prompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useScrollBehavior } from "@/context/scroll-behavior"
import { PromptInput } from "@/components/prompt-input"
import { Terminal } from "@/components/terminal"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Persist, persisted } from "@/utils/persist"
import { paneCache } from "./pane-cache"
import { makeViewKey } from "@/utils/layout-key"

const MAX_TERMINAL_HEIGHT = 200
const MAX_SESSION_CACHE = 50

export function MultiPanePromptPanel(props: { paneId: string; sessionId?: string }) {
  const multiPane = useMultiPane()
  const layout = useLayout()
  const terminal = useTerminal()
  const prompt = usePrompt()
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const viewKey = createMemo(() => makeViewKey({ paneId: props.paneId, directory: sdk.directory }))
  const view = createMemo(() => layout.view(viewKey()))
  const sessionInfo = createMemo(() => {
    const sessionId = props.sessionId
    if (!sessionId) return undefined
    return sync.session.get(sessionId)
  })
  const scrollBehavior = createMemo(() => useScrollBehavior(props.paneId))

  let editorRef: HTMLDivElement | undefined
  let containerRef: HTMLDivElement | undefined
  let resizeObserver: ResizeObserver | undefined

  onMount(() => {
    if (!containerRef) return
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
      scrollBehavior().setComposerHeight(height)
    })
    resizeObserver.observe(containerRef)
  })

  onCleanup(() => {
    resizeObserver?.disconnect()
  })

  type SessionCache = {
    agent: string | undefined
    model: { providerID: string; modelID: string } | undefined
    variant: string | null | undefined
    modeId: string | undefined
    thinking: boolean | undefined
  }

  type SessionCacheStore = {
    entries: Record<string, SessionCache>
    used: Record<string, number>
  }

  type PaneSnapshot = {
    prompt: Prompt
    promptDirty: boolean
    agent: string | undefined
    model: { providerID: string; modelID: string } | undefined
    variant: string | null | undefined
    modeId: string | undefined
    thinking: boolean | undefined
  }

  const paneSnapshots = new Map<string, PaneSnapshot>()
  const [sessionStore, setSessionStore, _, sessionReady] = persisted(
    Persist.global("pane-session", ["pane-session.v1"]),
    createStore<SessionCacheStore>({
      entries: {},
      used: {},
    }),
  )
  const [activeKey, setActiveKey] = createSignal<string | undefined>(undefined)
  const [restoring, setRestoring] = createSignal(false)
  let skipRestoreKey: string | undefined

  function handleSessionCreated(sessionId: string) {
    skipRestoreKey = sessionKeyFor(sessionId)
    multiPane.updatePane(props.paneId, { sessionId })
  }

  function sessionKeyFor(sessionId: string | undefined) {
    if (!sessionId) return undefined
    return `${sdk.directory}:${sessionId}`
  }

  function restorePaneState(paneId: string, session?: SessionCache, key?: string, skipModeRestore?: boolean) {
    const cached = paneCache.get(paneId)
    const useCache = !key
    const source = useCache ? cached : session
    setRestoring(true)
    setActiveKey(key)
    if (!skipModeRestore) {
      const modeId = source?.modeId
      if (modeId) local.mode.set(modeId)
    }
    queueMicrotask(() => {
      if (props.paneId !== paneId) {
        setRestoring(false)
        return
      }
      const agent = source?.agent
      if (agent) local.agent.set(agent)
      const model = source?.model
      if (model) local.model.set(model)
      const variant = source?.variant
      if (variant !== undefined) {
        const next = variant ?? undefined
        local.model.variant.set(next)
      }
      const thinking = source?.thinking
      if (thinking !== undefined) local.model.thinking.set(thinking)
      setRestoring(false)
    })
    if (useCache && cached?.prompt && !prompt.dirty()) prompt.set(cached.prompt)
  }

  function mergeSessionState(info: ReturnType<typeof sessionInfo>, cached?: SessionCache) {
    if (!info) return cached
    const next: SessionCache = {
      agent: cached?.agent,
      model: cached?.model,
      variant: cached?.variant,
      modeId: cached?.modeId,
      thinking: cached?.thinking,
    }
    if (info.agent !== undefined) next.agent = info.agent
    if (info.model !== undefined) next.model = info.model
    if (info.variant !== undefined) next.variant = info.variant
    if (info.mode) next.modeId = info.mode.id
    if (info.thinking !== undefined) next.thinking = info.thinking
    return next
  }

  function pruneSessionCache() {
    const keys = Object.keys(sessionStore.entries)
    if (keys.length <= MAX_SESSION_CACHE) return
    const ordered = keys.slice().sort((a, b) => (sessionStore.used[b] ?? 0) - (sessionStore.used[a] ?? 0))
    const drop = ordered.slice(MAX_SESSION_CACHE)
    if (drop.length === 0) return
    setSessionStore(
      produce((draft) => {
        for (const key of drop) {
          delete draft.entries[key]
          delete draft.used[key]
        }
      }),
    )
  }

  function storeSessionState(key: string, next: SessionCache) {
    setSessionStore("entries", key, next)
    setSessionStore("used", key, Date.now())
    pruneSessionCache()
  }

  function snapshotSessionState() {
    const currentAgent = local.agent.current()
    const currentModel = local.model.current()
    return {
      agent: currentAgent?.name,
      model: currentModel ? { providerID: currentModel.provider.id, modelID: currentModel.id } : undefined,
      variant: local.model.variant.current(),
      modeId: local.mode.current()?.id,
      thinking: local.model.thinking.current(),
    }
  }

  function snapshotPaneState() {
    const currentPrompt = prompt.current()
    const session = snapshotSessionState()
    return {
      prompt: currentPrompt,
      promptDirty: prompt.dirty(),
      agent: session.agent,
      model: session.model,
      variant: session.variant,
      modeId: session.modeId,
      thinking: session.thinking,
    }
  }

  function storePaneState(paneId: string, snapshot?: PaneSnapshot) {
    const state = snapshot ?? snapshotPaneState()
    const cache = paneCache.get(paneId) ?? {}
    if (state.prompt && state.promptDirty) {
      cache.prompt = state.prompt
    }
    if (state.agent) {
      cache.agent = state.agent
    }
    if (state.model) {
      cache.model = state.model
    }
    cache.variant = state.variant
    cache.modeId = state.modeId
    cache.thinking = state.thinking
    paneCache.set(paneId, cache)
  }

  function clearPanePrompt(paneId: string) {
    const cache = paneCache.get(paneId)
    if (!cache) return
    if (!cache.prompt) return
    delete cache.prompt
  }

  createEffect(
    on(
      () => props.paneId,
      (next, prev) => {
        if (prev) storePaneState(prev, paneSnapshots.get(prev))
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [props.paneId, props.sessionId, sdk.directory, sessionReady(), sessionInfo()] as const,
      ([paneId, sessionId, , ready, info]) => {
        if (!paneId) return
        const key = sessionKeyFor(sessionId)
        const cached = ready && key ? untrack(() => sessionStore.entries[key]) : undefined
        const session = mergeSessionState(info, cached)
        if (skipRestoreKey && key !== skipRestoreKey) {
          skipRestoreKey = undefined
        }
        // Skip restoring cached values for a session we just created in this pane.
        if (skipRestoreKey && key === skipRestoreKey) {
          setActiveKey(key)
          return
        }
        restorePaneState(paneId, session, key)
      },
    ),
  )

  createEffect(() => {
    if (restoring()) return
    const paneId = props.paneId
    if (!paneId) return
    const snapshot = snapshotPaneState()
    paneSnapshots.set(paneId, snapshot)
    storePaneState(paneId, snapshot)
  })

  createEffect(() => {
    const key = activeKey()
    if (!key) return
    if (restoring()) return
    if (!sessionReady()) return
    const next = snapshotSessionState()
    storeSessionState(key, next)
  })

  onCleanup(() => {
    storePaneState(props.paneId, paneSnapshots.get(props.paneId))
  })

  onMount(() => {
    requestAnimationFrame(() => {
      editorRef?.focus()
    })
  })

  createEffect(
    on(
      () => [props.paneId, props.sessionId, sdk.directory],
      () => {
        requestAnimationFrame(() => {
          editorRef?.focus()
        })
      },
    ),
  )

  return (
    <div ref={(el) => (containerRef = el)} class="shrink-0 flex flex-col">
      <div class="px-3 pt-2 flex justify-center">
        <div class="w-full max-w-[800px]">
          <PromptInput
            ref={(el) => (editorRef = el)}
            paneId={props.paneId}
            sessionId={props.sessionId}
            onSessionCreated={handleSessionCreated}
            onSubmitted={() => clearPanePrompt(props.paneId)}
          />
        </div>
      </div>

      <Show when={view().terminal.opened()}>
        <div class="px-3 pt-2 pb-2 flex justify-center">
          <div
            class="relative w-full max-w-[800px] flex flex-col shrink-0 border border-border-base rounded-md overflow-hidden"
            style={{ height: `${Math.min(layout.terminal.height(), MAX_TERMINAL_HEIGHT)}px` }}
          >
            <ResizeHandle
              direction="vertical"
              size={Math.min(layout.terminal.height(), MAX_TERMINAL_HEIGHT)}
              min={80}
              max={300}
              collapseThreshold={40}
              onResize={layout.terminal.resize}
              onCollapse={view().terminal.close}
            />
            <div class="absolute top-1 right-1 z-10">
              <Tooltip value="Close terminal panel" placement="left">
                <IconButton icon="close" variant="ghost" onClick={() => view().terminal.close()} />
              </Tooltip>
            </div>
            <Tabs variant="alt" value={terminal.active()} onChange={terminal.open}>
              <Tabs.List class="h-8">
                <For each={terminal.all()}>
                  {(pty: LocalPTY) => (
                    <Tabs.Trigger
                      value={pty.id}
                      closeButton={
                        <Tooltip value="Close terminal" placement="bottom">
                          <IconButton icon="close" variant="ghost" onClick={() => terminal.close(pty.id)} />
                        </Tooltip>
                      }
                    >
                      {pty.title}
                    </Tabs.Trigger>
                  )}
                </For>
                <div class="h-full flex items-center justify-center">
                  <Tooltip value="New terminal">
                    <IconButton icon="plus-small" variant="ghost" iconSize="large" onClick={terminal.new} />
                  </Tooltip>
                </div>
              </Tabs.List>
              <For each={terminal.all()}>
                {(pty: LocalPTY) => (
                  <Tabs.Content value={pty.id}>
                    <Terminal pty={pty} onCleanup={terminal.update} onConnectError={() => terminal.clone(pty.id)} />
                  </Tabs.Content>
                )}
              </For>
            </Tabs>
          </div>
        </div>
      </Show>
    </div>
  )
}
