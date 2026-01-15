import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, createMemo, createSignal, For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLocal } from "@/context/local"
import { useFloatingSelector } from "@/context/floating-selector"
import { popularProviders } from "@/hooks/use-providers"
import type { ModeDefinition } from "@/modes/types"
import { DialogEditMode } from "./dialog-edit-mode"

// Inline InstallModeDialog - same as in mode-selector.tsx
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

// Prevent focus steal on mousedown, but allow inputs to receive focus
const preventFocus = (e: MouseEvent) => {
  if (e.target instanceof HTMLInputElement) return
  e.preventDefault()
}

const InstallModeDialog: Component<{ mode: ModeDefinition; onInstalled?: () => void }> = (props) => {
  const dialog = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const [saving, setSaving] = createSignal(false)
  const missing = createMemo(() => local.mode.missingPlugins(props.mode))

  const handleInstall = async () => {
    if (saving()) return
    setSaving(true)
    try {
      const existing = sync.data.config.plugin ?? []
      const next = Array.from(new Set([...existing, ...missing()]))
      await sdk.client.config.update({
        config: {
          plugin: next,
        },
      })
      showToast({
        variant: "success",
        title: "Plugin added",
        description: "Restart OpenCode after installing dependencies.",
      })
      props.onInstalled?.()
      dialog.close()
    } catch (err) {
      const error = err as Error
      showToast({
        variant: "error",
        title: "Failed to update config",
        description: error.message,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Install plugin" description={`"${props.mode.name}" requires ${missing().join(", ")}`}>
      <div class="flex flex-col gap-4 px-2.5 pb-3">
        <div class="text-12-regular text-text-weak">
          Add the plugin to your config and complete installation to enable this mode.
        </div>
        <div class="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleInstall} disabled={saving()}>
            {saving() ? "Adding..." : "Add to config"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const MegaSelector: Component<{ class?: string; floating?: boolean }> = (props) => {
  const dialog = useDialog()
  const local = useLocal()
  const floatingSelector = useFloatingSelector()
  const [open, setOpen] = createSignal(false)
  const [modelSearch, setModelSearch] = createSignal("")
  const [isSearching, setIsSearching] = createSignal(false)
  const [selectedProvider, setSelectedProvider] = createSignal<string | undefined>(undefined)
  const [showProviderFilter, setShowProviderFilter] = createSignal(false)

  // Hover expansion state for Model column
  const [isModelExpanded, setIsModelExpanded] = createSignal(false)
  const [expandDirection, setExpandDirection] = createSignal<"up" | "down">("down")
  let modelColumnRef: HTMLDivElement | undefined

  // For floating mode, use floatingSelector state
  const isOpen = () => (props.floating ? floatingSelector.isOpen() : open())
  const handleClose = () => {
    if (props.floating) {
      floatingSelector.close()
    } else {
      setOpen(false)
    }
  }

  const handleModelHover = () => {
    // Only expand in opencode mode, not in claude code or codex modes
    if (!isOpencodeMode()) return
    if (isModelExpanded()) return
    const rect = modelColumnRef?.getBoundingClientRect()
    if (!rect) return

    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const expandedHeight = 500
    const baseHeight = 256 // Approximate base height

    // Expand up if tight below and spacious above
    // Add some buffer (20px) to spaceBelow check
    if (spaceBelow < (expandedHeight - baseHeight + 20) && spaceAbove > spaceBelow) {
      setExpandDirection("up")
    } else {
      setExpandDirection("down")
    }
    setIsModelExpanded(true)
  }

  const currentMode = createMemo(() => local.mode.current())
  const modes = createMemo(() => local.mode.list())
  const agents = createMemo(() => local.agent.list())
  const currentAgent = createMemo(() => local.agent.current())

  const isClaudeCodeMode = createMemo(() => currentMode()?.id === "claude-code")
  const isCodexMode = createMemo(() => currentMode()?.id === "codex")
  const isOpencodeMode = createMemo(() => currentMode()?.id === "opencode")

  const baseModels = createMemo(() =>
    local.model
      .list()
      .filter((m) => {
        if (isClaudeCodeMode()) {
          return m.provider.id === "claude-agent" || m.provider.id === "openrouter"
        }
        if (isCodexMode()) {
          return m.provider.id === "codex"
        }
        return m.provider.id !== "claude-agent" && m.provider.id !== "codex"
      })
      .filter((m) => {
        if (m.provider.id === "claude-agent" || m.provider.id === "codex") return true
        return local.model.visible({ modelID: m.id, providerID: m.provider.id })
      }),
  )

  // Get recent models (up to 5)
  const recentModels = createMemo(() => local.model.recent().slice(0, 5))

  // Get unique providers from available models (for opencode mode filter)
  const availableProviders = createMemo(() => {
    const providerMap = new Map<string, { id: string; name: string }>()
    for (const m of baseModels()) {
      if (!providerMap.has(m.provider.id)) {
        providerMap.set(m.provider.id, { id: m.provider.id, name: m.provider.name })
      }
    }
    return Array.from(providerMap.values()).sort((a, b) => a.name.localeCompare(b.name))
  })

  // Filter models
  const models = createMemo(() => {
    let result = baseModels()

    if (isOpencodeMode()) {
      // Provider filter
      const providerFilter = selectedProvider()
      if (providerFilter) {
        result = result.filter((m) => m.provider.id === providerFilter)
      }

      // Search filter
      const search = modelSearch().toLowerCase()
      if (search) {
        result = result.filter(
          (m) =>
            m.name.toLowerCase().includes(search) ||
            m.id.toLowerCase().includes(search) ||
            m.provider.name.toLowerCase().includes(search),
        )
      }
    }

    return result
  })

  const modelGroups = createMemo(() => {
    if (!isOpencodeMode()) return []
    const all = models()

    const key = (m: (typeof all)[number]) => `${m.provider.id}:${m.id}`

    const byKey = new Map<string, (typeof all)[number]>()
    for (const m of all) {
      byKey.set(key(m), m)
    }

    const favorites = all
      .filter((m) => local.model.favorite({ modelID: m.id, providerID: m.provider.id }))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))

    const favoriteSet = new Set<string>(favorites.map(key))

    const isDefined = <T,>(value: T | undefined | null): value is T => value !== undefined && value !== null

    const recent = recentModels()
      .filter(isDefined)
      .map((m) => byKey.get(`${m.provider.id}:${m.id}`))
      .filter(isDefined)
      .filter((m) => !favoriteSet.has(key(m)))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))

    const recentSet = new Set<string>(recent.map(key))

    const providerMap = new Map<string, { id: string; name: string; models: (typeof all)[number][] }>()
    for (const m of all) {
      const k = key(m)
      if (favoriteSet.has(k)) continue
      if (recentSet.has(k)) continue
      const existing = providerMap.get(m.provider.id)
      if (existing) {
        existing.models.push(m)
        continue
      }
      providerMap.set(m.provider.id, { id: m.provider.id, name: m.provider.name, models: [m] })
    }

    const providers = Array.from(providerMap.values())
      .map((p) => ({
        kind: "provider" as const,
        title: p.name,
        providerID: p.id,
        models: p.models.slice().sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => {
        const aPopular = popularProviders.includes(a.providerID)
        const bPopular = popularProviders.includes(b.providerID)
        if (aPopular && !bPopular) return -1
        if (!aPopular && bPopular) return 1
        if (aPopular && bPopular) return popularProviders.indexOf(a.providerID) - popularProviders.indexOf(b.providerID)
        return a.title.localeCompare(b.title)
      })

    const stripedProviders = providers.map((group, index) => {
      const alternate = index % 2 === 1
      return { ...group, alternate }
    })

    return [
      ...(favorites.length > 0
        ? [{ kind: "favorites" as const, title: "Favorites", models: favorites, alternate: false }]
        : []),
      ...(recent.length > 0 ? [{ kind: "recent" as const, title: "Recent", models: recent, alternate: false }] : []),
      ...stripedProviders,
    ]
  })

  const currentModel = createMemo(() => local.model.current())
  const variants = createMemo(() => local.model.variant.list())
  const currentVariant = createMemo(() => local.model.variant.current())
  const hasVariants = createMemo(() => variants().length > 0)

  const handleModeSelect = (mode: ModeDefinition) => {
    if (currentMode()?.id === mode.id) return
    if (!local.mode.isAvailable(mode)) {
      handleClose()
      dialog.show(() => <InstallModeDialog mode={mode} onInstalled={() => local.mode.set(mode.id)} />)
      return
    }
    local.mode.set(mode.id)
  }

  const handleModeEdit = (mode: ModeDefinition, event: MouseEvent) => {
    event.stopPropagation()
    handleClose()
    dialog.show(() => <DialogEditMode mode={mode} />)
  }

  // Floating position style
  const floatingPositionStyle = createMemo(() => {
    const pos = floatingSelector.position()
    return {
      position: "fixed" as const,
      left: `${pos.x}px`,
      top: `${pos.y - 16}px`,
      transform: "translate(-50%, -100%)",
      "z-index": "9999",
    }
  })

  // The content panel shared between popover and floating modes
  const ContentPanel = () => (
    <div class="flex h-full">
            {/* MODE COLUMN */}
            <div class="flex flex-col p-2 border-r border-border-base w-[180px] shrink-0">
              <div class="text-11-regular text-text-subtle px-1 pb-1 uppercase tracking-wider shrink-0">Mode</div>
              <div class="flex flex-col gap-0.5 flex-1 overflow-y-auto no-scrollbar">
                <For each={modes()}>
                  {(mode) => {
                    const missing = createMemo(() => local.mode.missingPlugins(mode))
                    const isCurrent = createMemo(() => currentMode()?.id === mode.id)
                    return (
                      <div class="group flex items-center">
                        <button
                          type="button"
                          class="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover text-left"
                          classList={{
                            "bg-surface-interactive-base": isCurrent(),
                            "opacity-70": missing().length > 0,
                          }}
                          onClick={() => handleModeSelect(mode)}
                          onMouseEnter={() => {
                            if (props.floating && floatingSelector.isHoldDragMode()) {
                              floatingSelector.setHoveredAction(() => handleModeSelect(mode))
                            }
                          }}
                          onMouseLeave={() => {
                            if (props.floating && floatingSelector.isHoldDragMode()) {
                              floatingSelector.setHoveredAction(null)
                            }
                          }}
                        >
                          <span
                            class="flex-1 text-13-medium truncate"
                            classList={{
                              "text-text-interactive-base": isCurrent(),
                              "text-text-strong": !isCurrent(),
                            }}
                          >
                            {mode.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          class="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-surface-raised-base-hover"
                          onClick={(e) => handleModeEdit(mode, e)}
                        >
                          <Icon name="edit-small-2" size="small" class="text-icon-base" />
                        </button>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>

            {/* AGENT COLUMN */}
            <div class="flex flex-col p-2 border-r border-border-base w-[130px] shrink-0">
              <div class="text-11-regular text-text-subtle px-1 pb-1 uppercase tracking-wider shrink-0">Agent</div>
              <div class="flex flex-col gap-0.5 flex-1 overflow-y-auto no-scrollbar">
                <For each={agents()}>
                  {(agent) => {
                    const isCurrent = createMemo(() => currentAgent()?.name === agent.name)
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover text-left"
                        classList={{ "bg-surface-interactive-base": isCurrent() }}
                        onClick={() => local.agent.set(agent.name)}
                        onMouseEnter={() => {
                          if (props.floating && floatingSelector.isHoldDragMode()) {
                            floatingSelector.setHoveredAction(() => local.agent.set(agent.name))
                          }
                        }}
                        onMouseLeave={() => {
                          if (props.floating && floatingSelector.isHoldDragMode()) {
                            floatingSelector.setHoveredAction(null)
                          }
                        }}
                      >
                        <span
                          class="flex-1 text-13-medium capitalize truncate"
                          classList={{
                            "text-text-interactive-base": isCurrent(),
                            "text-text-strong": !isCurrent(),
                          }}
                        >
                          {agent.name}
                        </span>
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>

            {/* MODEL COLUMN */}
            <div
              ref={(el) => (modelColumnRef = el)}
              class="relative border-r border-border-base w-[240px] shrink-0"
              onMouseEnter={handleModelHover}
              onMouseLeave={() => {
                setIsModelExpanded(false)
                setExpandDirection("down")
              }}
            >
              <div
                class="flex flex-col p-2 bg-surface-raised-stronger-non-alpha transition-[height,transform] duration-200 ease-out"
                classList={{
                  "absolute left-0 top-0 z-50 shadow-xl rounded-md": isModelExpanded(),
                  "relative h-full": !isModelExpanded(),
                }}
                style={{
                  width: "240px",
                  height: isModelExpanded() ? "500px" : undefined,
                  transform: isModelExpanded() && expandDirection() === "up" ? "translateY(-244px)" : undefined,
                }}
              >
              {/* Header: MODEL text or search input */}
              <Show
                when={isOpencodeMode()}
                fallback={
                  <div class="text-11-regular text-text-subtle px-1 pb-1 uppercase tracking-wider shrink-0">Model</div>
                }
              >
                <div class="flex items-center px-1 pb-1 shrink-0">
                  <Show
                    when={isSearching()}
                    fallback={
                      <button
                        type="button"
                        class="text-11-regular text-text-subtle uppercase tracking-wider flex-1 text-left hover:text-text-base cursor-text"
                        onClick={() => setIsSearching(true)}
                      >
                        Model
                      </button>
                    }
                  >
                    <input
                      ref={(el) => queueMicrotask(() => el.focus())}
                      type="text"
                      placeholder="Search..."
                      value={modelSearch()}
                      onInput={(e) => setModelSearch(e.currentTarget.value)}
                      onBlur={() => {
                        if (!modelSearch()) setIsSearching(false)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setModelSearch("")
                          setIsSearching(false)
                        }
                      }}
                      class="flex-1 min-w-0 text-11-regular bg-transparent placeholder:text-text-weak focus:outline-none"
                    />
                  </Show>
                  <button
                    type="button"
                    class="p-0.5 rounded hover:bg-surface-raised-base-hover"
                    onClick={() => {
                      if (isSearching()) {
                        setModelSearch("")
                        setIsSearching(false)
                      } else {
                        setIsSearching(true)
                      }
                    }}
                    title={isSearching() ? "Clear search" : "Search models"}
                  >
                    <Icon name={isSearching() ? "close" : "magnifying-glass"} size="small" class="text-icon-weak" />
                  </button>
                  <button
                    type="button"
                    class="p-0.5 rounded hover:bg-surface-raised-base-hover"
                    classList={{ "text-icon-accent-base": !!selectedProvider() || showProviderFilter() }}
                    onClick={() => setShowProviderFilter(!showProviderFilter())}
                    title="Filter by provider"
                  >
                    <Icon
                      name="chevron-down"
                      size="small"
                      classList={{ "text-icon-weak": !selectedProvider() && !showProviderFilter() }}
                    />
                  </button>
                </div>
                {/* Provider filter dropdown */}
                <Show when={showProviderFilter()}>
                  <div class="flex flex-col gap-0.5 pb-1 mb-1 border-b border-border-base max-h-32 overflow-y-auto no-scrollbar">
                    <button
                      type="button"
                      class="px-2 py-1 text-12-regular text-left rounded hover:bg-surface-raised-base-hover shrink-0"
                      classList={{ "bg-surface-raised-base-hover text-text-strong": !selectedProvider() }}
                      onClick={() => {
                        setSelectedProvider(undefined)
                        setShowProviderFilter(false)
                      }}
                    >
                      All providers
                    </button>
                    <For each={availableProviders()}>
                      {(provider) => (
                        <button
                          type="button"
                          class="px-2 py-1 text-12-regular text-left rounded hover:bg-surface-raised-base-hover truncate shrink-0"
                          classList={{
                            "bg-surface-raised-base-hover text-text-strong": selectedProvider() === provider.id,
                          }}
                          onClick={() => {
                            setSelectedProvider(provider.id)
                            setShowProviderFilter(false)
                          }}
                        >
                          {provider.name}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
              <div class="flex flex-col gap-0.5 flex-1 overflow-y-auto no-scrollbar">
                <Show
                  when={isOpencodeMode()}
                  fallback={
                    <For each={models()}>
                      {(model) => {
                        const isCurrent = createMemo(
                          () => currentModel()?.id === model.id && currentModel()?.provider.id === model.provider.id,
                        )
                        return (
                          <div class="group flex items-center">
                            <button
                              type="button"
                              class="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover text-left min-w-0"
                              classList={{ "bg-surface-interactive-base": isCurrent() }}
                              onClick={() => {
                                local.model.set({ modelID: model.id, providerID: model.provider.id }, { recent: true })
                              }}
                              onMouseEnter={() => {
                                if (props.floating && floatingSelector.isHoldDragMode()) {
                                  floatingSelector.setHoveredAction(() =>
                                    local.model.set({ modelID: model.id, providerID: model.provider.id }, { recent: true })
                                  )
                                }
                              }}
                              onMouseLeave={() => {
                                if (props.floating && floatingSelector.isHoldDragMode()) {
                                  floatingSelector.setHoveredAction(null)
                                }
                              }}
                            >
                              <span
                                class="flex-1 text-13-regular truncate"
                                classList={{
                                  "text-text-interactive-base": isCurrent(),
                                  "text-text-strong": !isCurrent(),
                                }}
                              >
                                {model.name}
                              </span>
                              <Show when={model.provider.id === "opencode" && (!model.cost || model.cost?.input === 0)}>
                                <Tag>Free</Tag>
                              </Show>
                              <Show when={model.latest}>
                                <Tag>Latest</Tag>
                              </Show>
                            </button>
                          </div>
                        )
                      }}
                    </For>
                  }
                >
                  <For each={modelGroups()}>
                    {(group) => {
                      const showProviderIcon = group.kind !== "provider"
                      return (
                        <div class="flex flex-col" classList={{ "bg-surface-raised-base-hover": group.alternate }}>
                          <div
                            class="sticky top-0 z-10 px-2 py-1.5 text-16-medium text-text-base flex items-center gap-2"
                            classList={{
                              "bg-surface-raised-stronger-non-alpha": !group.alternate,
                              "bg-surface-raised-base-hover": group.alternate,
                            }}
                          >
                            <Show when={group.kind === "provider" && "providerID" in group}>
                              <ProviderIcon
                                id={((group as { providerID: string }).providerID === "codex" ? "openai" : (group as { providerID: string }).providerID) as IconName}
                                class="size-4 shrink-0"
                              />
                            </Show>
                            {group.title}
                          </div>
                          <For each={group.models}>
                            {(model) => {
                              const isCurrent = createMemo(
                                () =>
                                  currentModel()?.id === model.id && currentModel()?.provider.id === model.provider.id,
                              )
                              const isFavorite = createMemo(() =>
                                local.model.favorite({ modelID: model.id, providerID: model.provider.id }),
                              )
                              return (
                                <div class="group flex items-center">
                                  <button
                                    type="button"
                                    class="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover text-left min-w-0"
                                    classList={{ "bg-surface-interactive-base": isCurrent() }}
                                    onClick={() => {
                                      local.model.set(
                                        { modelID: model.id, providerID: model.provider.id },
                                        { recent: true },
                                      )
                                    }}
                                    onMouseEnter={() => {
                                      if (props.floating && floatingSelector.isHoldDragMode()) {
                                        floatingSelector.setHoveredAction(() =>
                                          local.model.set(
                                            { modelID: model.id, providerID: model.provider.id },
                                            { recent: true },
                                          )
                                        )
                                      }
                                    }}
                                    onMouseLeave={() => {
                                      if (props.floating && floatingSelector.isHoldDragMode()) {
                                        floatingSelector.setHoveredAction(null)
                                      }
                                    }}
                                  >
                                    <Show when={showProviderIcon}>
                                      <ProviderIcon
                                        id={(model.provider.id === "codex" ? "openai" : model.provider.id) as IconName}
                                        class="size-4 shrink-0"
                                      />
                                    </Show>
                                    <span
                                      class="flex-1 text-13-regular truncate"
                                      classList={{
                                        "text-text-interactive-base": isCurrent(),
                                        "text-text-strong": !isCurrent(),
                                      }}
                                    >
                                      {model.name}
                                    </span>
                                    <Show
                                      when={
                                        model.provider.id === "opencode" && (!model.cost || model.cost?.input === 0)
                                      }
                                    >
                                      <Tag>Free</Tag>
                                    </Show>
                                    <Show when={model.latest}>
                                      <Tag>Latest</Tag>
                                    </Show>
                                  </button>
                                  <button
                                    type="button"
                                    class="p-1 rounded hover:bg-surface-raised-base-hover shrink-0"
                                    classList={{
                                      "opacity-0 group-hover:opacity-100": !isFavorite(),
                                      "opacity-100": isFavorite(),
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      local.model.toggleFavorite({ modelID: model.id, providerID: model.provider.id })
                                    }}
                                    title={isFavorite() ? "Remove from favorites" : "Add to favorites"}
                                  >
                                    <Icon
                                      name="check"
                                      size="small"
                                      classList={{
                                        "text-icon-success-base": isFavorite(),
                                        "text-icon-weak": !isFavorite(),
                                      }}
                                    />
                                  </button>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      )
                    }}
                  </For>
                </Show>
                <Show when={models().length === 0}>
                  <div class="px-2 py-3 text-12-regular text-text-weak text-center">No models found</div>
                </Show>
              </div>
             </div>
            </div>

            {/* OPTIONS COLUMN (Variant + Extended Thinking) */}
            <div class="flex flex-col p-2 flex-1 overflow-hidden">
              <div class="text-11-regular text-text-subtle px-1 pb-1 uppercase tracking-wider shrink-0">Options</div>
              <div class="flex flex-col gap-2 flex-1 overflow-y-auto no-scrollbar">
                {/* VARIANT SECTION */}
                <Show when={hasVariants()}>
                  <div class="flex flex-col gap-1">
                    <div class="text-11-regular text-text-weak px-1">Thinking Effort</div>
                    <div class="flex flex-col gap-0.5">
                      <button
                        type="button"
                        class="px-2 py-1 rounded text-12-regular text-left hover:bg-surface-raised-base-hover"
                        classList={{
                          "bg-surface-interactive-base text-text-interactive-base":
                            currentVariant() === undefined,
                          "text-text-strong": currentVariant() !== undefined,
                        }}
                        onClick={() => local.model.variant.set(undefined)}
                        onMouseEnter={() => {
                          if (props.floating && floatingSelector.isHoldDragMode()) {
                            floatingSelector.setHoveredAction(() => local.model.variant.set(undefined))
                          }
                        }}
                        onMouseLeave={() => {
                          if (props.floating && floatingSelector.isHoldDragMode()) {
                            floatingSelector.setHoveredAction(null)
                          }
                        }}
                      >
                        Default
                      </button>
                      <For each={variants()}>
                        {(variant) => (
                          <button
                            type="button"
                            class="px-2 py-1 rounded text-12-regular capitalize text-left hover:bg-surface-raised-base-hover"
                            classList={{
                              "bg-surface-interactive-base text-text-interactive-base":
                                currentVariant() === variant,
                              "text-text-strong": currentVariant() !== variant,
                            }}
                            onClick={() => local.model.variant.set(variant)}
                            onMouseEnter={() => {
                              if (props.floating && floatingSelector.isHoldDragMode()) {
                                floatingSelector.setHoveredAction(() => local.model.variant.set(variant))
                              }
                            }}
                            onMouseLeave={() => {
                              if (props.floating && floatingSelector.isHoldDragMode()) {
                                floatingSelector.setHoveredAction(null)
                              }
                            }}
                          >
                            {variant}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* EXTENDED THINKING SECTION (Claude Code only) */}
                <Show when={isClaudeCodeMode()}>
                  <div class="flex items-center justify-between gap-2 px-1 py-1.5">
                    <span class="text-12-regular text-text-base">Extended Thinking</span>
                    <Switch
                      checked={local.model.thinking.current()}
                      onChange={(checked) => local.model.thinking.set(checked)}
                    />
                  </div>
                </Show>

                {/* Fallback when no options available */}
                <Show when={!hasVariants() && !isClaudeCodeMode()}>
                  <div class="px-2 py-3 text-12-regular text-text-weak text-center">No options available</div>
                </Show>
              </div>
            </div>
          </div>
  )

  // Floating mode: render as Portal at mouse position
  if (props.floating) {
    return (
      <Show when={isOpen()}>
        <Portal>
          <div
            data-floating-selector
            tabIndex={-1}
            style={floatingPositionStyle()}
            class="animate-in fade-in zoom-in-95 duration-150"
            onMouseDown={preventFocus}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div class="w-[690px] h-64 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg">
              <ContentPanel />
            </div>
          </div>
        </Portal>
      </Show>
    )
  }

  // Normal popover mode
  return (
    <Kobalte open={open()} onOpenChange={setOpen} placement="top-start" gutter={8}>
      <Kobalte.Trigger as="div" class={props.class}>
        <Button variant="ghost" class="gap-1.5">
          <span class="truncate max-w-[120px]">{currentMode()?.name ?? "Mode"}</span>
          <span class="text-text-weak">/</span>
          <span class="truncate max-w-[80px] capitalize">{currentAgent()?.name ?? "Agent"}</span>
          <Icon name="chevron-down" size="small" />
        </Button>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="w-[690px] h-64 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none" onContextMenu={(e) => e.preventDefault()}>
          <Kobalte.Title class="sr-only">Mode, Agent, and Model settings</Kobalte.Title>
          <ContentPanel />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
