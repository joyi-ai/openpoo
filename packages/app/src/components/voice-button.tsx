import { Show, createEffect } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useVoice } from "@/context/voice"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { SettingsDialog } from "./settings-dialog"

interface VoiceButtonProps {
  onTranscription?: (text: string) => void
}

export function VoiceButton(props: VoiceButtonProps) {
  const voice = useVoice()
  const dialog = useDialog()
  const sdk = useSDK()

  // Watch for transcription results and call the callback
  createEffect(() => {
    const text = voice.state.lastTranscription()
    if (text && props.onTranscription) {
      props.onTranscription(text)
      voice.actions.clearTranscription()
    }
  })

  const handleClick = () => {
    // If model not ready, show settings dialog to download
    if (voice.state.modelStatus() !== "ready") {
      dialog.show(() => (
        <SDKProvider directory={sdk.directory}>
          <SyncProvider>
            <LocalProvider>
              <SettingsDialog />
            </LocalProvider>
          </SyncProvider>
        </SDKProvider>
      ))
      return
    }

    // Toggle recording
    voice.actions.toggle()
  }

  const getTooltipText = () => {
    if (voice.state.modelStatus() === "not-downloaded") {
      return "Download voice model"
    }
    if (voice.state.modelStatus() === "downloading") {
      return "Downloading model..."
    }
    if (voice.state.modelStatus() === "error") {
      return "Model error - click to retry"
    }
    if (voice.state.isTranscribing()) {
      return "Transcribing..."
    }
    if (voice.state.isRecording()) {
      return "Stop recording"
    }
    return "Start voice input"
  }

  const getIconName = () => {
    if (voice.state.isRecording()) {
      return "microphone-recording"
    }
    return "microphone"
  }

  return (
    <Tooltip placement="top" value={getTooltipText()}>
      <Button
        type="button"
        variant="ghost"
        class="size-6"
        classList={{
          "text-icon-critical-base": voice.state.isRecording(),
        }}
        onClick={handleClick}
        disabled={voice.state.isTranscribing() || voice.state.modelStatus() === "downloading"}
      >
        <Show when={!voice.state.isTranscribing()} fallback={<Spinner class="size-4.5" />}>
          <Icon
            name={getIconName()}
            class="size-4.5"
            classList={{
              "animate-pulse": voice.state.isRecording(),
            }}
          />
        </Show>
      </Button>
    </Tooltip>
  )
}
