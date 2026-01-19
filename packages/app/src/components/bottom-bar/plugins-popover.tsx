import { type ParentProps, Show, createMemo, createSignal } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"
import { useMultiPane } from "@/context/multi-pane"
import { ClaudePluginsPanel } from "@/components/settings/claude-plugins-panel"
import { OpenCodePluginsPanel } from "@/components/settings/opencode-plugins-panel"

function PluginsContent() {
  const [activeTab, setActiveTab] = createSignal<"claude" | "opencode">("claude")

  return (
    <div class="w-80 max-h-80 overflow-y-auto flex flex-col gap-3">
      <div class="flex gap-1 p-0.5 rounded-md bg-surface-raised-base">
        <button
          type="button"
          class="flex-1 px-3 py-1 rounded text-12-medium transition-colors"
          classList={{
            "bg-background-base text-text-strong shadow-sm": activeTab() === "claude",
            "text-text-base hover:text-text-strong": activeTab() !== "claude",
          }}
          onClick={() => setActiveTab("claude")}
        >
          Claude
        </button>
        <button
          type="button"
          class="flex-1 px-3 py-1 rounded text-12-medium transition-colors"
          classList={{
            "bg-background-base text-text-strong shadow-sm": activeTab() === "opencode",
            "text-text-base hover:text-text-strong": activeTab() !== "opencode",
          }}
          onClick={() => setActiveTab("opencode")}
        >
          OpenCode
        </button>
      </div>
      <Show when={activeTab() === "claude"}>
        <ClaudePluginsPanel variant="dialog" />
      </Show>
      <Show when={activeTab() === "opencode"}>
        <OpenCodePluginsPanel />
      </Show>
    </div>
  )
}

function PluginsPopoverInner(props: ParentProps) {
  return (
    <Kobalte gutter={8} placement="top-end" modal={false}>
      <Kobalte.Trigger as="div" class="cursor-pointer">
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="z-50 rounded-lg border border-border-base bg-background-base shadow-lg p-3 animate-in fade-in-0 zoom-in-95">
          <div class="flex items-center justify-between pb-2 border-b border-border-weak-base mb-2">
            <div class="flex items-center gap-2">
              <Icon name="code" size="small" class="text-icon-base" />
              <span class="text-13-medium text-text-strong">Plugins</span>
            </div>
            <Kobalte.CloseButton as={IconButton} icon="close" variant="ghost" />
          </div>
          <PluginsContent />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export function PluginsPopover(props: ParentProps) {
  const multiPane = useMultiPane()
  const focusedDirectory = createMemo(() => {
    const pane = multiPane.focusedPane()
    if (!pane) return undefined
    return pane.worktree ?? pane.directory
  })

  return (
    <Show when={focusedDirectory()} fallback={props.children}>
      {(directory) => (
        <SDKProvider directory={directory()}>
          <SyncProvider>
            <PluginsPopoverInner>{props.children}</PluginsPopoverInner>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
