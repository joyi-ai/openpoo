import { Component, Show, Match, Switch as SolidSwitch, createMemo, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { Popover } from "@opencode-ai/ui/popover"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Select } from "@opencode-ai/ui/select"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { useVoice } from "@/context/voice"
import { usePlatform } from "@/context/platform"
import { formatKeybind } from "@/context/command"
import { useKeybindCapture } from "@/hooks/use-keybind-capture"

export const SettingsPopover: Component = () => {
  const permission = usePermission()
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const layout = useLayout()
  const voice = useVoice()
  const platform = usePlatform()

  const {
    isCapturing: isCapturingKeybind,
    setIsCapturing: setIsCapturingKeybind,
    setCapturedKeybind,
    handleKeyDown: handleKeybindKeyDown,
  } = useKeybindCapture(voice.settings.keybind(), {
    onCapture: (keybind) => voice.settings.setKeybind(keybind),
  })

  const sessionID = () => params.id
  const isGitProject = createMemo(() => sync.data.vcs !== undefined)
  const hasPermissions = createMemo(() => permission.permissionsEnabled() && sessionID())
  const isDesktop = () => platform.platform === "desktop"
  const deviceOptions = createMemo(() => {
    const devices = voice.state.availableDevices()
    return [
      { id: "default", label: "System Default" },
      ...devices.map((device) => ({ id: device.id, label: device.label })),
    ]
  })
  const currentDevice = createMemo(() => {
    const options = deviceOptions()
    const currentId = voice.settings.deviceId() ?? "default"
    const match = options.find((option) => option.id === currentId)
    if (match) return match
    return options[0]
  })

  onMount(() => {
    voice.actions.refreshDevices()
  })

  return (
    <Popover
      placement="top"
      trigger={
        <IconButton
          icon="settings-gear"
          variant="ghost"
          class="size-6"
          classList={{
            "text-icon-success-base": !!(sessionID() && permission.isAutoAccepting(sessionID()!)),
          }}
        />
      }
      title="Settings"
      class="min-w-64"
    >
      <div class="flex flex-col gap-3 pt-2">
        {/* Worktree Section - for new sessions */}
        <Show when={isGitProject()}>
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-strong">New Sessions</div>
            <Switch checked={layout.worktree.enabled()} onChange={(checked) => layout.worktree.setEnabled(checked)}>
              Enable worktree isolation
            </Switch>
            <Show when={layout.worktree.enabled()}>
              <div class="flex flex-col gap-1 pl-6">
                <div class="text-11-medium text-text-base">Cleanup</div>
                <div class="flex flex-col gap-0.5">
                  <label class="flex items-center gap-2 text-11-regular text-text-base cursor-pointer">
                    <input
                      type="radio"
                      name="cleanup"
                      checked={layout.worktree.cleanup() === "ask"}
                      onChange={() => layout.worktree.setCleanup("ask")}
                      class="accent-icon-success-base"
                    />
                    Ask when deleting
                  </label>
                  <label class="flex items-center gap-2 text-11-regular text-text-base cursor-pointer">
                    <input
                      type="radio"
                      name="cleanup"
                      checked={layout.worktree.cleanup() === "always"}
                      onChange={() => layout.worktree.setCleanup("always")}
                      class="accent-icon-success-base"
                    />
                    Always delete
                  </label>
                  <label class="flex items-center gap-2 text-11-regular text-text-base cursor-pointer">
                    <input
                      type="radio"
                      name="cleanup"
                      checked={layout.worktree.cleanup() === "never"}
                      onChange={() => layout.worktree.setCleanup("never")}
                      class="accent-icon-success-base"
                    />
                    Never delete
                  </label>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* Permission Mode Section - only when in a session */}
        <Show when={hasPermissions()}>
          <Show when={isGitProject()}>
            <div class="border-t border-border-base" />
          </Show>
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-strong">Permissions</div>
            <div class="flex flex-col gap-1">
              <Button
                variant={permission.isAutoAccepting(sessionID()!) ? "primary" : "ghost"}
                class="justify-start gap-2 h-8"
                onClick={() => permission.toggleAutoAccept(sessionID()!, sdk.directory)}
              >
                <Icon
                  name="chevron-double-right"
                  size="small"
                  classList={{
                    "text-icon-success-base": permission.isAutoAccepting(sessionID()!),
                  }}
                />
                <span class="text-13-regular">Auto-accept edits</span>
                <Show when={permission.isAutoAccepting(sessionID()!)}>
                  <Icon name="check" size="small" class="ml-auto text-icon-success-base" />
                </Show>
              </Button>
            </div>
          </div>
        </Show>

        {/* Voice Input Section - only on desktop */}
        <Show when={isDesktop()}>
          <div class="border-t border-border-base" />
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-strong">Voice Input</div>

            {/* Model Status */}
            <div class="flex items-center gap-2">
              <SolidSwitch>
                <Match when={voice.state.modelStatus() === "not-downloaded"}>
                  <div class="flex items-center gap-2 flex-1">
                    <Icon name="microphone" size="small" class="text-icon-subtle" />
                    <span class="text-13-regular text-text-base flex-1">Model not downloaded</span>
                    <Button variant="primary" size="small" onClick={() => voice.actions.downloadModel()}>
                      Download
                    </Button>
                  </div>
                </Match>
                <Match when={voice.state.modelStatus() === "downloading"}>
                  <div class="flex items-center gap-2 flex-1">
                    <ProgressCircle percentage={voice.state.downloadProgress() * 100} size={16} />
                    <span class="text-13-regular text-text-base">
                      Downloading... {Math.round(voice.state.downloadProgress() * 100)}%
                    </span>
                  </div>
                </Match>
                <Match when={voice.state.modelStatus() === "ready"}>
                  <div class="flex items-center gap-2 flex-1">
                    <Icon name="check" size="small" class="text-icon-success-base" />
                    <span class="text-13-regular text-text-success-base">Model ready</span>
                  </div>
                </Match>
                <Match when={voice.state.modelStatus() === "error"}>
                  <div class="flex items-center gap-2 flex-1">
                    <Icon name="circle-x" size="small" class="text-icon-critical-base" />
                    <span class="text-13-regular text-text-critical-base flex-1 truncate">
                      {voice.state.error() || "Error"}
                    </span>
                    <Button variant="ghost" size="small" onClick={() => voice.actions.downloadModel()}>
                      Retry
                    </Button>
                  </div>
                </Match>
              </SolidSwitch>
            </div>

            <div class="flex items-center gap-2">
              <span class="text-12-regular text-text-subtle">Microphone:</span>
              <div class="flex-1">
                <Select
                  options={deviceOptions()}
                  current={currentDevice()}
                  value={(option) => option.id}
                  label={(option) => option.label}
                  onSelect={(option) => {
                    const deviceId = option?.id ?? "default"
                    voice.settings.setDeviceId(deviceId === "default" ? null : deviceId)
                  }}
                  variant="ghost"
                  size="small"
                  class="justify-between"
                  disabled={!voice.state.isSupported()}
                />
              </div>
              <Button
                variant="ghost"
                size="small"
                onClick={() => voice.actions.refreshDevices()}
                disabled={!voice.state.isSupported()}
              >
                Refresh
              </Button>
            </div>

            {/* Hotkey and Mode */}
            <Show when={voice.state.modelStatus() === "ready"}>
              <div class="flex items-center gap-2">
                <span class="text-12-regular text-text-subtle">Hotkey:</span>
                <button
                  type="button"
                  class="px-2 py-1 rounded bg-surface-raised-base border border-border-base text-12-regular text-text-base font-mono"
                  classList={{
                    "ring-2 ring-border-focus-base": isCapturingKeybind(),
                  }}
                  onClick={() => {
                    setCapturedKeybind(voice.settings.keybind())
                    setIsCapturingKeybind(true)
                  }}
                  onKeyDown={handleKeybindKeyDown}
                  onBlur={() => setIsCapturingKeybind(false)}
                >
                  <Show when={!isCapturingKeybind()} fallback={<span class="text-text-subtle">Press keys...</span>}>
                    {formatKeybind(voice.settings.keybind())}
                  </Show>
                </button>
              </div>

              {/* Recording Mode */}
              <div class="flex items-center gap-2">
                <span class="text-12-regular text-text-subtle">Mode:</span>
                <div class="flex gap-1">
                  <button
                    type="button"
                    class="px-2 py-1 rounded text-12-regular"
                    classList={{
                      "bg-surface-info-base/20 text-text-info-base": voice.settings.mode() === "toggle",
                      "bg-surface-raised-base text-text-subtle hover:text-text-base":
                        voice.settings.mode() !== "toggle",
                    }}
                    onClick={() => voice.settings.setMode("toggle")}
                  >
                    Toggle
                  </button>
                  <button
                    type="button"
                    class="px-2 py-1 rounded text-12-regular"
                    classList={{
                      "bg-surface-info-base/20 text-text-info-base": voice.settings.mode() === "push-to-talk",
                      "bg-surface-raised-base text-text-subtle hover:text-text-base":
                        voice.settings.mode() !== "push-to-talk",
                    }}
                    onClick={() => voice.settings.setMode("push-to-talk")}
                  >
                    Push to Talk
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* Info Section */}
        <div class="pt-2 border-t border-border-base">
          <div class="text-11-regular text-text-subtle">
            <Show when={isGitProject() && !hasPermissions()}>
              When worktree is enabled, new sessions will be created in an isolated git worktree.
            </Show>
            <Show when={hasPermissions()}>
              When auto-accept is enabled, file edits are automatically approved without prompting.
            </Show>
          </div>
        </div>
      </div>
    </Popover>
  )
}
