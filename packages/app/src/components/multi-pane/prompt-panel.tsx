import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { useMultiPane } from "@/context/multi-pane"
import { useLayout } from "@/context/layout"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { usePrompt, type Prompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { PromptInput } from "@/components/prompt-input"
import { Terminal } from "@/components/terminal"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { paneCache } from "./pane-cache"

const MAX_TERMINAL_HEIGHT = 200

export function MultiPanePromptPanel(props: { paneId: string; sessionId?: string }) {
  const multiPane = useMultiPane()
  const layout = useLayout()
  const terminal = useTerminal()
  const prompt = usePrompt()
  const local = useLocal()
  const sdk = useSDK()
  const sessionKey = createMemo(
    () => `multi-${props.paneId}-${sdk.directory}${props.sessionId ? "/" + props.sessionId : ""}`,
  )
  const view = createMemo(() => layout.view(sessionKey()))

  let editorRef: HTMLDivElement | undefined

  type PaneSnapshot = {
    prompt: Prompt
    promptDirty: boolean
    agent: string | undefined
    model: { providerID: string; modelID: string } | undefined
    variant: string | undefined
    modeId: string | undefined
    thinking: boolean | undefined
  }

  const paneSnapshots = new Map<string, PaneSnapshot>()

  function handleSessionCreated(sessionId: string) {
    multiPane.updatePane(props.paneId, { sessionId })
  }

  function restorePaneState(paneId: string) {
    const cached = paneCache.get(paneId)
    if (!cached) return
    if (cached.modeId) local.mode.set(cached.modeId)
    queueMicrotask(() => {
      if (props.paneId !== paneId) return
      if (cached.agent) local.agent.set(cached.agent)
      if (cached.model) local.model.set(cached.model)
      if (cached.variant !== undefined) local.model.variant.set(cached.variant)
      if (cached.thinking !== undefined) local.model.thinking.set(cached.thinking)
    })
    if (cached.prompt && !prompt.dirty()) prompt.set(cached.prompt)
  }

  function snapshotPaneState() {
    const currentPrompt = prompt.current()
    const currentAgent = local.agent.current()
    const currentModel = local.model.current()
    return {
      prompt: currentPrompt,
      promptDirty: prompt.dirty(),
      agent: currentAgent?.name,
      model: currentModel ? { providerID: currentModel.provider.id, modelID: currentModel.id } : undefined,
      variant: local.model.variant.current(),
      modeId: local.mode.current()?.id,
      thinking: local.model.thinking.current(),
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

  restorePaneState(props.paneId)

  createEffect(() => {
    paneSnapshots.set(props.paneId, snapshotPaneState())
  })

  createEffect(
    on(
      () => props.paneId,
      (next, prev) => {
        if (prev) storePaneState(prev, paneSnapshots.get(prev))
        if (next) restorePaneState(next)
      },
      { defer: true },
    ),
  )

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
    <div class="shrink-0 flex flex-col border-t border-border-weak-base">
      <Show when={view().terminal.opened()}>
        <div
          class="relative w-full flex flex-col shrink-0"
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
      </Show>

      <div class="p-3 flex justify-center">
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
    </div>
  )
}
