import { Component, Show, createMemo, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { BUILTIN_MODES } from "@/modes/definitions"
import type { ModeDefinition } from "@/modes/types"

type ProviderOption = {
  id: string
  label: string
  value: string | null
}

type AgentOption = {
  id: string
  label: string
  value: string | null
  description?: string
}

export const ModeSettingsPanel: Component<{
  mode: ModeDefinition
  onClose?: () => void
  showCancel?: boolean
}> = (props) => {
  const local = useLocal()
  const sync = useSync()
  const providers = useProviders()

  const baseMode = createMemo(
    () =>
      BUILTIN_MODES.find((item) => item.id === props.mode.id) ??
      local.mode.custom.list().find((item) => item.id === props.mode.id) ??
      props.mode,
  )

  const buildStore = () => {
    const override = local.mode.getOverride(props.mode.id)
    const initialProviderOverride = override?.providerOverride === undefined ? null : override.providerOverride
    const initialDefaultAgent = override?.defaultAgent === undefined ? null : override.defaultAgent
    return {
      name: props.mode.name,
      description: props.mode.description ?? "",
      providerOverride: initialProviderOverride as string | null | undefined,
      defaultAgent: initialDefaultAgent as string | null | undefined,
    }
  }

  const [store, setStore] = createStore(buildStore())

  createEffect(
    on(
      () => props.mode.id,
      () => {
        setStore(buildStore())
      },
    ),
  )

  const providerOptions = createMemo<ProviderOption[]>(() => [
    { id: "none", label: "No override", value: null },
    ...providers.connected().map((provider) => ({
      id: provider.id,
      label: provider.name,
      value: provider.id,
    })),
  ])

  const currentProviderOption = createMemo(
    () => providerOptions().find((option) => option.value === store.providerOverride) ?? providerOptions()[0],
  )

  const agentOptions = createMemo(() =>
    local.mode.filterAgents(
      sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden),
      props.mode,
    ),
  )

  const defaultAgentOptions = createMemo<AgentOption[]>(() => {
    const defaultLabel = baseMode().defaultAgent ? `Mode default (${baseMode().defaultAgent})` : "Mode default"
    return [
      { id: "mode-default", label: defaultLabel, value: null },
      ...agentOptions().map((agent) => ({
        id: agent.name,
        label: agent.name,
        value: agent.name,
        description: agent.description,
      })),
    ]
  })

  const currentAgentOption = createMemo(
    () => defaultAgentOptions().find((option) => option.value === store.defaultAgent) ?? defaultAgentOptions()[0],
  )

  const isClaudeCode = () => props.mode.id === "claude-code"
  const isCodexMode = () => props.mode.id === "codex"
  const isLockedProvider = () => isClaudeCode() || isCodexMode()
  const hasOverrides = createMemo(() => !!local.mode.getOverride(props.mode.id))

  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault()
    local.mode.setOverride(props.mode.id, {
      name: store.name.trim() || baseMode().name,
      description: store.description.trim() || undefined,
      providerOverride: isLockedProvider() ? props.mode.providerOverride : (store.providerOverride ?? undefined),
      defaultAgent: store.defaultAgent ?? undefined,
    })
    props.onClose?.()
  }

  const handleReset = () => {
    local.mode.resetOverride(props.mode.id)
    props.onClose?.()
  }

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-6">
      <div class="flex flex-col gap-4">
        <TextField
          autofocus
          type="text"
          label="Display name"
          value={store.name}
          onChange={(value) => setStore("name", value)}
        />
        <TextField
          multiline
          label="Description"
          value={store.description}
          onChange={(value) => setStore("description", value)}
          placeholder="Describe when to use this mode"
        />
        <div class="flex flex-col gap-2">
          <label class="text-12-medium text-text-weak">Default provider</label>
          <Show
            when={!isLockedProvider()}
            fallback={
              <div class="text-13-regular text-text-strong px-2 py-1.5 rounded-md border border-border-base bg-surface-raised-base">
                {props.mode.providerOverride ?? "claude-agent"}
              </div>
            }
          >
            <Select
              options={providerOptions()}
              current={currentProviderOption()}
              value={(option) => option.id}
              label={(option) => option.label}
              onSelect={(option) => setStore("providerOverride", option?.value ?? null)}
              variant="ghost"
              class="justify-between"
            />
          </Show>
        </div>
        <div class="flex flex-col gap-2">
          <label class="text-12-medium text-text-weak">Default agent</label>
          <Select
            options={defaultAgentOptions()}
            current={currentAgentOption()}
            value={(option) => option.id}
            label={(option) => option.label}
            onSelect={(option) => setStore("defaultAgent", option?.value ?? null)}
            variant="ghost"
            class="justify-between"
          />
        </div>
      </div>

      <div class="flex items-center justify-between">
        <Button type="button" variant="ghost" disabled={!hasOverrides()} onClick={handleReset}>
          Reset to defaults
        </Button>
        <div class="flex items-center gap-2">
          <Show when={props.showCancel}>
            <Button type="button" variant="ghost" onClick={() => props.onClose?.()}>
              Cancel
            </Button>
          </Show>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </div>
    </form>
  )
}
