import { type ParentProps, createMemo, Match, onMount, Show, Switch } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Select } from "@opencode-ai/ui/select"
import { useVoice } from "@/context/voice"
import { formatKeybind } from "@/context/command"
import { useKeybindCapture } from "@/hooks/use-keybind-capture"

function VoiceSettingsContent() {
  const voice = useVoice()
  const { isCapturing, setIsCapturing, capturedKeybind, handleKeyDown } = useKeybindCapture(voice.settings.keybind(), {
    onCapture: (keybind) => voice.settings.setKeybind(keybind),
  })

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
    voice.settings.markConfigured()
  })

  const handleDownload = () => {
    voice.actions.downloadModel()
  }

  return (
    <div class="w-80 max-h-80 overflow-y-auto flex flex-col gap-4">
      {/* Model Status */}
      <Switch>
        <Match when={voice.state.modelStatus() === "not-downloaded"}>
          <div class="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-raised-base">
            <span class="text-12-regular text-text-base">Voice model (~700MB)</span>
            <Button variant="primary" size="small" onClick={handleDownload}>
              Download
            </Button>
          </div>
        </Match>
        <Match when={voice.state.modelStatus() === "downloading"}>
          <div class="flex items-center gap-3 p-2 rounded-md bg-surface-raised-base">
            <ProgressCircle percentage={voice.state.downloadProgress() * 100} size={16} />
            <span class="text-12-regular text-text-base">
              {Math.round(voice.state.downloadProgress() * 100)}%
            </span>
          </div>
        </Match>
        <Match when={voice.state.modelStatus() === "ready"}>
          <div class="flex items-center gap-2 p-2 rounded-md bg-surface-success-base/10">
            <Icon name="check" size="small" class="text-icon-success-base" />
            <span class="text-12-regular text-text-success-base">Ready</span>
          </div>
        </Match>
        <Match when={voice.state.modelStatus() === "error"}>
          <div class="flex items-center justify-between gap-2 p-2 rounded-md bg-surface-critical-base/10">
            <div class="flex items-center gap-2">
              <Icon name="circle-x" size="small" class="text-icon-critical-base" />
              <span class="text-12-regular text-text-critical-base">Failed</span>
            </div>
            <Button variant="ghost" size="small" onClick={handleDownload}>
              Retry
            </Button>
          </div>
        </Match>
      </Switch>

      {/* Microphone */}
      <div class="flex items-center gap-2">
        <Select
          options={deviceOptions()}
          current={currentDevice()}
          value={(option) => option.id}
          label={(option) => option.label}
          onSelect={(option) => {
            const id = option?.id ?? "default"
            voice.settings.setDeviceId(id === "default" ? null : id)
          }}
          variant="ghost"
          class="flex-1 justify-between text-12-regular"
          disabled={!voice.state.isSupported()}
        />
        <IconButton
          variant="ghost"
          icon="retry"
          onClick={() => voice.actions.refreshDevices()}
          disabled={!voice.state.isSupported()}
        />
      </div>

      {/* Hotkey & Recording Mode */}
      <div class="flex gap-2">
        <button
          type="button"
          class="flex-1 px-3 py-2 rounded-md bg-surface-raised-base text-12-regular text-text-base text-left focus:outline-none focus:ring-1 focus:ring-border-focus-base"
          classList={{ "ring-1 ring-border-focus-base": isCapturing() }}
          onClick={() => setIsCapturing(true)}
          onKeyDown={handleKeyDown}
          onBlur={() => setIsCapturing(false)}
        >
          <Show when={!isCapturing()} fallback={<span class="text-text-subtle">Press hotkey...</span>}>
            <span class="font-mono">{formatKeybind(capturedKeybind())}</span>
          </Show>
        </button>
        <button
          type="button"
          class="px-3 py-2 rounded-md text-12-medium transition-colors"
          classList={{
            "bg-surface-info-base/20 text-text-info-base ring-1 ring-border-info-base": voice.settings.mode() === "toggle",
            "bg-surface-raised-base text-text-base hover:bg-surface-raised-hover": voice.settings.mode() !== "toggle",
          }}
          onClick={() => voice.settings.setMode("toggle")}
        >
          Toggle
        </button>
        <button
          type="button"
          class="px-3 py-2 rounded-md text-12-medium transition-colors"
          classList={{
            "bg-surface-info-base/20 text-text-info-base ring-1 ring-border-info-base": voice.settings.mode() === "push-to-talk",
            "bg-surface-raised-base text-text-base hover:bg-surface-raised-hover": voice.settings.mode() !== "push-to-talk",
          }}
          onClick={() => voice.settings.setMode("push-to-talk")}
        >
          Hold
        </button>
      </div>
    </div>
  )
}

export function SettingsPopover(props: ParentProps) {
  return (
    <Kobalte gutter={8} placement="top-end" modal={false}>
      <Kobalte.Trigger as="div" class="cursor-pointer">
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content class="z-50 rounded-lg border border-border-base bg-background-base shadow-lg p-3 animate-in fade-in-0 zoom-in-95">
          <div class="flex items-center justify-between pb-2 border-b border-border-weak-base mb-2">
            <div class="flex items-center gap-2">
              <Icon name="settings-gear" size="small" class="text-icon-base" />
              <span class="text-13-medium text-text-strong">Settings</span>
            </div>
            <Kobalte.CloseButton as={IconButton} icon="close" variant="ghost" />
          </div>
          <VoiceSettingsContent />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
