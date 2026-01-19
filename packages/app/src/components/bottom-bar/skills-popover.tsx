import { type ParentProps, Show, createMemo } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"
import { useMultiPane } from "@/context/multi-pane"
import { SkillsPanel } from "@/components/settings/skills-panel"

function SkillsContent() {
  return (
    <div class="w-80 max-h-80 overflow-y-auto">
      <SkillsPanel />
    </div>
  )
}

function SkillsPopoverInner(props: ParentProps) {
  return (
    <Kobalte gutter={8} placement="top-end" modal={false}>
      <Kobalte.Trigger as="div" class="cursor-pointer">
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="z-50 rounded-lg border border-border-base bg-background-base shadow-lg p-3 animate-in fade-in-0 zoom-in-95">
          <div class="flex items-center justify-between pb-2 border-b border-border-weak-base mb-2">
            <div class="flex items-center gap-2">
              <Icon name="brain" size="small" class="text-icon-base" />
              <span class="text-13-medium text-text-strong">Skills</span>
            </div>
            <Kobalte.CloseButton as={IconButton} icon="close" variant="ghost" />
          </div>
          <SkillsContent />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export function SkillsPopover(props: ParentProps) {
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
            <SkillsPopoverInner>{props.children}</SkillsPopoverInner>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
