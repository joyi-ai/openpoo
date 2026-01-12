import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, createMemo, createSignal, For, JSX, Show } from "solid-js"
import { useLocal, type LocalModel } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { DialogSelectProvider } from "./dialog-select-provider"
import { DialogManageModels } from "./dialog-manage-models"
import { DialogConnectProvider } from "./dialog-connect-provider"

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  showSearch?: boolean
  showFavorites?: boolean
}> = (props) => {
  const local = useLocal()
  const isClaudeCodeMode = createMemo(() => local.mode.current()?.id === "claude-code")
  const isCodexMode = createMemo(() => local.mode.current()?.id === "codex")
  const [hoveredModel, setHoveredModel] = createSignal<string | null>(null)

  const models = createMemo(() =>
    local.model
      .list()
      .filter((m) => {
        // In Claude Code mode, show claude-agent models and openrouter models
        // In other modes, hide claude-agent models
        if (isClaudeCodeMode()) {
          return m.provider.id === "claude-agent" || m.provider.id === "openrouter"
        }
        if (isCodexMode()) {
          return m.provider.id === "codex"
        }
        return m.provider.id !== "claude-agent" && m.provider.id !== "codex"
      })
      .filter((m) => {
        // Skip visibility check for claude-agent models since they're always available
        if (m.provider.id === "claude-agent" || m.provider.id === "codex") return true
        return local.model.visible({ modelID: m.id, providerID: m.provider.id })
      })
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  // Get recent models (up to 5)
  const recentModels = createMemo(() => local.model.recent().slice(0, 5))

  // Sort models: favorites first, then recent, then alphabetical by provider
  const sortedModels = createMemo(() => {
    const allModels = models()
    const favSet = new Set<string>()
    const recentSet = new Set<string>()

    // Build favorite set
    for (const m of allModels) {
      if (local.model.favorite({ modelID: m.id, providerID: m.provider.id })) {
        favSet.add(`${m.provider.id}:${m.id}`)
      }
    }

    // Build recent set (excluding favorites)
    for (const r of recentModels()) {
      if (!r) continue
      const key = `${r.provider.id}:${r.id}`
      if (!favSet.has(key)) {
        recentSet.add(key)
      }
    }

    return allModels.slice().sort((a, b) => {
      const aKey = `${a.provider.id}:${a.id}`
      const bKey = `${b.provider.id}:${b.id}`
      const aFav = favSet.has(aKey)
      const bFav = favSet.has(bKey)
      const aRecent = recentSet.has(aKey)
      const bRecent = recentSet.has(bKey)

      // Favorites first
      if (aFav && !bFav) return -1
      if (!aFav && bFav) return 1

      // Then recent
      if (aRecent && !bRecent) return -1
      if (!aRecent && bRecent) return 1

      // Then alphabetical
      return a.name.localeCompare(b.name)
    })
  })

  const shouldShowSearch = () => props.showSearch ?? true

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={shouldShowSearch() ? { placeholder: "Search models", autofocus: true } : undefined}
      emptyMessage="No model results"
      key={(x) => `${x.provider.id}:${x.id}`}
      items={props.showFavorites ? sortedModels : models}
      current={local.model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={props.showFavorites ? undefined : (a, b) => a.name.localeCompare(b.name)}
      groupBy={props.showFavorites ? undefined : (x) => x.provider.name}
      sortGroupsBy={
        props.showFavorites
          ? undefined
          : (a, b) => {
              if (a.category === "Recent" && b.category !== "Recent") return -1
              if (b.category === "Recent" && a.category !== "Recent") return 1
              const aProvider = a.items[0].provider.id
              const bProvider = b.items[0].provider.id
              if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
              if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
              return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
            }
      }
      onSelect={(x) => {
        local.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => {
        const modelKey = () => `${i.provider.id}:${i.id}`
        const isFavorite = () => local.model.favorite({ modelID: i.id, providerID: i.provider.id })
        const isHovered = () => hoveredModel() === modelKey()

        return (
          <div
            class="w-full flex items-center gap-x-2 text-13-regular group"
            onMouseEnter={() => setHoveredModel(modelKey())}
            onMouseLeave={() => setHoveredModel(null)}
          >
            <Show when={props.showFavorites}>
              <button
                type="button"
                class="size-4 flex items-center justify-center shrink-0 -ml-1"
                classList={{
                  "opacity-0 group-hover:opacity-100": !isFavorite(),
                  "opacity-100": isFavorite(),
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  local.model.toggleFavorite({ modelID: i.id, providerID: i.provider.id })
                }}
                title={isFavorite() ? "Remove from favorites" : "Add to favorites"}
              >
                <Icon
                  name="check"
                  class="size-3.5"
                  classList={{
                    "text-icon-success-base": isFavorite(),
                    "text-icon-weak-base hover:text-icon-base": !isFavorite(),
                  }}
                />
              </button>
            </Show>
            <span class="truncate">{i.name}</span>
            <Show when={props.showFavorites}>
              <span class="text-11-regular text-text-weak truncate">{i.provider.name}</span>
            </Show>
            <Show when={i.provider.id === "opencode" && (!i.cost || i.cost?.input === 0)}>
              <Tag>Free</Tag>
            </Show>
            <Show when={i.latest}>
              <Tag>Latest</Tag>
            </Show>
          </div>
        )
      }}
    </List>
  )
}

export const ModelSelectorPopover: Component<{
  provider?: string
  children: JSX.Element
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  const local = useLocal()
  const isClaudeCodeMode = createMemo(() => local.mode.current()?.id === "claude-code")

  return (
    <Kobalte open={open()} onOpenChange={setOpen} placement="top-start" gutter={8}>
      <Kobalte.Trigger as="div">{props.children}</Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="w-72 h-80 flex flex-col rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden">
          <Kobalte.Title class="sr-only">Select model</Kobalte.Title>
          <div class="h-72 flex flex-col">
            <ModelList provider={props.provider} onSelect={() => setOpen(false)} class="p-1" />
          </div>
          <Show when={isClaudeCodeMode()}>
            <div class="px-3 py-2.5 border-t border-border-base flex items-center justify-between">
              <div class="flex flex-col">
                <span class="text-13-medium text-text-base">Extended Thinking</span>
                <span class="text-11-regular text-text-weak">Deeper reasoning</span>
              </div>
              <Switch
                checked={local.model.thinking.current()}
                onChange={(checked) => local.model.thinking.set(checked)}
              />
            </div>
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string }> = (props) => {
  const dialog = useDialog()
  const local = useLocal()
  const isClaudeCodeMode = createMemo(() => local.mode.current()?.id === "claude-code")
  const isCodexMode = createMemo(() => local.mode.current()?.id === "codex")
  const variants = createMemo(() => local.model.variant.list())
  const currentVariant = createMemo(() => local.model.variant.current())
  const hasVariants = createMemo(() => variants().length > 0)

  if (isCodexMode()) {
    return (
      <Dialog
        title="Select model"
        description="Codex models"
        action={
          <Button
            class="h-7 -my-1 text-14-medium"
            icon="plus-small"
            tabIndex={-1}
            onClick={() => dialog.show(() => <DialogConnectProvider provider="codex" />)}
          >
            Connect Codex
          </Button>
        }
      >
        <ModelList provider="codex" onSelect={() => dialog.close()} />
        <Show when={hasVariants()}>
          <div class="px-3 py-3 border-t border-border-base flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">Reasoning effort</div>
            <div class="flex flex-col gap-1">
              <button
                type="button"
                class="px-2 py-1 rounded text-12-regular text-left"
                classList={{
                  "bg-surface-info-base/20 text-text-info-base": currentVariant() === undefined,
                  "hover:bg-surface-raised-base-hover text-text-subtle": currentVariant() !== undefined,
                }}
                onClick={() => local.model.variant.set(undefined)}
              >
                Default
              </button>
              <For each={variants()}>
                {(variant) => (
                  <button
                    type="button"
                    class="px-2 py-1 rounded text-12-regular capitalize text-left"
                    classList={{
                      "bg-surface-info-base/20 text-text-info-base": currentVariant() === variant,
                      "hover:bg-surface-raised-base-hover text-text-subtle": currentVariant() !== variant,
                    }}
                    onClick={() => local.model.variant.set(variant)}
                  >
                    {variant}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Dialog>
    )
  }

  if (isClaudeCodeMode()) {
    return (
      <Dialog title="Select model" description="Claude Code models">
        <ModelList provider={props.provider} onSelect={() => dialog.close()} />
        <div class="px-3 py-3 border-t border-border-base flex items-center justify-between">
          <div class="flex flex-col">
            <span class="text-13-medium text-text-base">Extended Thinking</span>
            <span class="text-12-regular text-text-weak">Enable deeper reasoning</span>
          </div>
          <Switch checked={local.model.thinking.current()} onChange={(checked) => local.model.thinking.set(checked)} />
        </div>
      </Dialog>
    )
  }

  // OpenCode mode: show search bar (replaces title), favorites, and recent
  return (
    <Dialog
      title=""
      action={
        <Button
          class="h-7 -my-1 text-14-medium"
          icon="plus-small"
          tabIndex={-1}
          onClick={() => dialog.show(() => <DialogSelectProvider />)}
        >
          Connect provider
        </Button>
      }
    >
      <ModelList provider={props.provider} onSelect={() => dialog.close()} showSearch showFavorites />
      <Button
        variant="ghost"
        class="ml-3 mt-5 mb-6 text-text-base self-start"
        onClick={() => dialog.show(() => <DialogManageModels />)}
      >
        Manage models
      </Button>
    </Dialog>
  )
}
