import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { showToast } from "@opencode-ai/ui/toast"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { ModeDefinition } from "@/modes/types"
import { DialogEditMode } from "./dialog-edit-mode"

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

export const ModeSelector: Component = () => {
  const dialog = useDialog()
  const local = useLocal()
  const [open, setOpen] = createSignal(false)

  const modes = createMemo(() => local.mode.list())
  const current = createMemo(() => local.mode.current())

  const handleSelect = (mode: ModeDefinition) => {
    if (current()?.id === mode.id) {
      setOpen(false)
      return
    }
    if (!local.mode.isAvailable(mode)) {
      setOpen(false)
      dialog.show(() => <InstallModeDialog mode={mode} onInstalled={() => local.mode.set(mode.id)} />)
      return
    }
    local.mode.set(mode.id)
    setOpen(false)
  }

  const handleEdit = (mode: ModeDefinition) => {
    setOpen(false)
    dialog.show(() => <DialogEditMode mode={mode} />)
  }

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="top-start"
      class="w-80 max-h-96"
      trigger={
        <Button variant="ghost" class="gap-1.5">
          <span class="size-2 rounded-full" style={{ "background-color": current()?.color ?? "#3D405B" }} />
          <Icon name={(current()?.icon as any) ?? "code"} size="small" class="text-icon-info-active" />
          <span class="truncate max-w-[120px]">{current()?.name ?? "Mode"}</span>
          <Icon name="chevron-down" size="small" />
        </Button>
      }
    >
      <div class="flex flex-col gap-1 p-1 max-h-80 overflow-y-auto">
        <For each={modes()}>
          {(mode) => {
            const missing = createMemo(() => local.mode.missingPlugins(mode))
            const isCurrent = createMemo(() => current()?.id === mode.id)
            return (
              <div class="group flex items-start gap-1 rounded-md">
                <button
                  type="button"
                  class="flex-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised-base-hover"
                  classList={{
                    "bg-surface-raised-base-hover": isCurrent(),
                    "opacity-70": missing().length > 0,
                  }}
                  onClick={() => handleSelect(mode)}
                >
                  <div class="flex items-center gap-2">
                    <span class="size-2 rounded-full" style={{ "background-color": mode.color ?? "#3D405B" }} />
                    <Icon name={(mode.icon as any) ?? "code"} size="small" class="text-icon-info-active" />
                    <span class="text-13-medium text-text-strong">{mode.name}</span>
                    <Show when={isCurrent()}>
                      <Icon name="check-small" size="small" class="text-icon-success-base" />
                    </Show>
                  </div>
                  <Show when={mode.description}>
                    <div class="text-12-regular text-text-weak mt-0.5">{mode.description}</div>
                  </Show>
                  <Show when={missing().length > 0}>
                    <div class="text-11-regular text-text-subtle mt-0.5">Requires {missing().join(", ")}</div>
                  </Show>
                </button>
                <IconButton
                  type="button"
                  icon="edit-small-2"
                  variant="ghost"
                  class="mt-1 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleEdit(mode)
                  }}
                />
              </div>
            )
          }}
        </For>
        <div class="border-t border-border-base my-1" />
        <button
          type="button"
          disabled
          class="w-full text-left px-2 py-1.5 text-12-regular text-text-weak opacity-60 cursor-not-allowed"
        >
          Create custom mode (coming soon)
        </button>
      </div>
    </Popover>
  )
}
