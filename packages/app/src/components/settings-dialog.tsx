import {
  Component,
  For,
  Show,
  Match,
  Switch as SolidSwitch,
  createMemo,
  createSignal,
  onMount,
} from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Select } from "@opencode-ai/ui/select"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useVoice } from "@/context/voice"
import { usePlatform } from "@/context/platform"
import { formatKeybind } from "@/context/command"
import { useKeybindCapture } from "@/hooks/use-keybind-capture"
import { McpPanel } from "@/components/dialog-select-mcp"
import Marketplace from "@/pages/marketplace"

type SettingsTab = "voice" | "skills" | "mcp" | "plugins" | "marketplace"

export const SettingsDialogButton: Component = () => {
  const dialog = useDialog()

  return (
    <IconButton
      icon="settings-gear"
      variant="ghost"
      class="size-6"
      onClick={() => dialog.show(() => <SettingsDialog />)}
    />
  )
}

export const SettingsDialog: Component<{ initialTab?: SettingsTab }> = (props) => {
  const voice = useVoice()
  const platform = usePlatform()
  const [tab, setTab] = createSignal<SettingsTab>(props.initialTab ?? "voice")

  const {
    isCapturing: isCapturingKeybind,
    setIsCapturing: setIsCapturingKeybind,
    setCapturedKeybind,
    handleKeyDown: handleKeybindKeyDown,
  } = useKeybindCapture(voice.settings.keybind(), {
    onCapture: (keybind) => voice.settings.setKeybind(keybind),
  })

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
    <Dialog title="Settings" description="Manage skills, MCP servers, plugins, and voice settings." size="lg">
      <Tabs value={tab()} onChange={(value) => setTab(value as SettingsTab)} variant="alt" class="min-h-[520px]">
        <Tabs.List>
          <For
            each={[
              { id: "voice", label: "Voice" },
              { id: "skills", label: "Skills" },
              { id: "mcp", label: "MCP" },
              { id: "plugins", label: "Plugins" },
              { id: "marketplace", label: "Marketplace" },
            ]}
          >
            {(item) => <Tabs.Trigger value={item.id}>{item.label}</Tabs.Trigger>}
          </For>
        </Tabs.List>

        <Tabs.Content value="voice">
          <div class="flex flex-col gap-4 px-2.5 pb-3">
            <Show
              when={isDesktop()}
              fallback={
                <div class="text-13-regular text-text-weak">Voice input settings are available on desktop.</div>
              }
            >
              <div class="flex flex-col gap-2">
                <div class="text-12-medium text-text-strong">Voice Input</div>

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
                      <Show
                        when={!isCapturingKeybind()}
                        fallback={<span class="text-text-subtle">Press keys...</span>}
                      >
                        {formatKeybind(voice.settings.keybind())}
                      </Show>
                    </button>
                  </div>

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
          </div>
        </Tabs.Content>

        <Tabs.Content value="skills">
          <div class="px-2.5 pb-3 text-13-regular text-text-weak">Skills configuration coming next.</div>
        </Tabs.Content>

        <Tabs.Content value="mcp">
          <McpPanel />
        </Tabs.Content>

        <Tabs.Content value="plugins">
          <div class="px-2.5 pb-3 text-13-regular text-text-weak">OpenCode plugin configuration coming next.</div>
        </Tabs.Content>

        <Tabs.Content value="marketplace">
          <Marketplace />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
