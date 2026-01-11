import { createMemo, createSignal, Match, onMount, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Select } from "@opencode-ai/ui/select"
import { useVoice, type RecordingMode } from "@/context/voice"
import { formatKeybind } from "@/context/command"
import { useKeybindCapture } from "@/hooks/use-keybind-capture"

export function DialogVoiceSettings() {
  const dialog = useDialog()
  const voice = useVoice()
  const { isCapturing, setIsCapturing, capturedKeybind, handleKeyDown } = useKeybindCapture(voice.settings.keybind())
  const [selectedMode, setSelectedMode] = createSignal<RecordingMode>(voice.settings.mode())
  const [selectedDevice, setSelectedDevice] = createSignal<string>(voice.settings.deviceId() ?? "default")

  const deviceOptions = createMemo(() => {
    const devices = voice.state.availableDevices()
    return [
      { id: "default", label: "System Default" },
      ...devices.map((device) => ({ id: device.id, label: device.label })),
    ]
  })

  const currentDevice = createMemo(() => {
    const options = deviceOptions()
    const currentId = selectedDevice()
    const match = options.find((option) => option.id === currentId)
    if (match) return match
    return options[0]
  })

  onMount(() => {
    voice.actions.refreshDevices()
  })

  const handleSave = () => {
    voice.settings.setKeybind(capturedKeybind())
    voice.settings.setMode(selectedMode())
    const deviceId = selectedDevice()
    voice.settings.setDeviceId(deviceId === "default" ? null : deviceId)
    voice.settings.markConfigured()
    dialog.close()
  }

  const handleDownload = () => {
    voice.actions.downloadModel()
  }

  return (
    <Dialog title="Voice Input Settings">
      <div class="flex flex-col gap-4 px-2.5 pb-3">
        {/* Header */}
        <div class="flex items-start gap-3">
          <div class="p-2 rounded-lg bg-surface-info-base/20">
            <Icon name="microphone" size="normal" class="text-icon-info-active" />
          </div>
          <div class="flex flex-col gap-1">
            <div class="text-14-medium text-text-strong">Voice Input</div>
            <div class="text-13-regular text-text-base">Transcribe speech to text using local AI (Parakeet model).</div>
          </div>
        </div>

        {/* Model Status */}
        <div class="flex flex-col gap-2 pt-2 border-t border-border-base">
          <div class="text-12-medium text-text-subtle">Model Status</div>
          <Switch>
            <Match when={voice.state.modelStatus() === "not-downloaded"}>
              <div class="flex items-center gap-2">
                <div class="flex-1 text-13-regular text-text-base">Model not downloaded (~700MB)</div>
                <Button variant="primary" size="small" onClick={handleDownload}>
                  Download
                </Button>
              </div>
            </Match>
            <Match when={voice.state.modelStatus() === "downloading"}>
              <div class="flex items-center gap-3">
                <ProgressCircle percentage={voice.state.downloadProgress() * 100} size={20} />
                <div class="flex-1 text-13-regular text-text-base">
                  Downloading... {Math.round(voice.state.downloadProgress() * 100)}%
                </div>
              </div>
            </Match>
            <Match when={voice.state.modelStatus() === "ready"}>
              <div class="flex items-center gap-2">
                <Icon name="check" size="small" class="text-icon-success-base" />
                <div class="text-13-regular text-text-success-base">Model ready</div>
              </div>
            </Match>
            <Match when={voice.state.modelStatus() === "error"}>
              <div class="flex items-center gap-2">
                <Icon name="circle-x" size="small" class="text-icon-critical-base" />
                <div class="flex-1 text-13-regular text-text-critical-base">
                  {voice.state.error() || "Download failed"}
                </div>
                <Button variant="ghost" size="small" onClick={handleDownload}>
                  Retry
                </Button>
              </div>
            </Match>
          </Switch>
        </div>

        {/* Microphone */}
        <div class="flex flex-col gap-2 pt-2 border-t border-border-base">
          <div class="text-12-medium text-text-subtle">Microphone</div>
          <div class="flex items-center gap-2">
            <div class="flex-1">
              <Select
                options={deviceOptions()}
                current={currentDevice()}
                value={(option) => option.id}
                label={(option) => option.label}
                onSelect={(option) => {
                  const next = option?.id ?? "default"
                  setSelectedDevice(next)
                }}
                variant="ghost"
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
        </div>

        {/* Keybind Configuration */}
        <div class="flex flex-col gap-2 pt-2 border-t border-border-base">
          <div class="text-12-medium text-text-subtle">Hotkey</div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex-1 px-3 py-2 rounded-md bg-surface-raised-base border border-border-base text-13-regular text-text-base text-left focus:outline-none focus:ring-2 focus:ring-border-focus-base"
              classList={{
                "ring-2 ring-border-focus-base": isCapturing(),
              }}
              onClick={() => setIsCapturing(true)}
              onKeyDown={handleKeyDown}
              onBlur={() => setIsCapturing(false)}
            >
              <Show when={!isCapturing()} fallback={<span class="text-text-subtle">Press keys...</span>}>
                <span class="font-mono">{formatKeybind(capturedKeybind())}</span>
              </Show>
            </button>
          </div>
          <div class="text-11-regular text-text-subtle">
            Only works when the app is focused. Click to record a new hotkey.
          </div>
        </div>

        {/* Recording Mode */}
        <div class="flex flex-col gap-2 pt-2 border-t border-border-base">
          <div class="text-12-medium text-text-subtle">Recording Mode</div>
          <div class="flex flex-col gap-1">
            <button
              type="button"
              class="flex items-center gap-2 px-3 py-2 rounded-md text-left"
              classList={{
                "bg-surface-info-base/20 ring-1 ring-border-info-base": selectedMode() === "toggle",
                "bg-surface-raised-base hover:bg-surface-raised-hover": selectedMode() !== "toggle",
              }}
              onClick={() => setSelectedMode("toggle")}
            >
              <Icon name="microphone" size="small" class="text-icon-base" />
              <div class="flex-1">
                <div class="text-13-regular text-text-base">Toggle Mode</div>
                <div class="text-11-regular text-text-subtle">
                  Press hotkey to start, press again to stop and transcribe
                </div>
              </div>
            </button>
            <button
              type="button"
              class="flex items-center gap-2 px-3 py-2 rounded-md text-left"
              classList={{
                "bg-surface-info-base/20 ring-1 ring-border-info-base": selectedMode() === "push-to-talk",
                "bg-surface-raised-base hover:bg-surface-raised-hover": selectedMode() !== "push-to-talk",
              }}
              onClick={() => setSelectedMode("push-to-talk")}
            >
              <Icon name="microphone" size="small" class="text-icon-base" />
              <div class="flex-1">
                <div class="text-13-regular text-text-base">Push to Talk</div>
                <div class="text-11-regular text-text-subtle">
                  Hold hotkey to record, release to stop and transcribe
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Actions */}
        <div class="flex justify-end gap-2 pt-2 border-t border-border-base">
          <Button variant="ghost" size="normal" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button variant="primary" size="normal" onClick={handleSave} disabled={voice.state.modelStatus() !== "ready"}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
