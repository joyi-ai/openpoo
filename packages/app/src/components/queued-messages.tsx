import { For, Show, type Component } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { QueuedMessage } from "@/context/message-queue"

interface QueuedMessagesProps {
  queue: QueuedMessage[]
  onEdit: (message: QueuedMessage) => void
  onSendNow: (messageId: string) => void
  onDelete: (messageId: string) => void
}

export const QueuedMessages: Component<QueuedMessagesProps> = (props) => {
  return (
    <Show when={props.queue.length > 0}>
      <div
        data-component="queued-messages"
        class="absolute inset-x-0 -top-3 -translate-y-full z-10
               flex flex-col p-1.5 rounded-md
               border border-border-base bg-surface-raised-stronger-non-alpha shadow-md"
      >
        <For each={props.queue}>
          {(message, index) => (
            <>
              <Show when={index() > 0}>
                <div class="mx-2 my-1">
                  <div
                    class="h-px bg-gradient-to-r from-transparent via-border-weak to-transparent"
                    style={{ opacity: "0.6" }}
                  />
                </div>
              </Show>
              <div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-raised-base-hover group">
                <div class="flex-1 min-w-0">
                  <p class="text-13-regular text-text-base truncate">{message.text}</p>
                </div>
                <div class="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip value="Edit message" placement="top">
                    <IconButton
                      icon="edit-small-2"
                      variant="ghost"
                      onClick={() => props.onEdit(message)}
                    />
                  </Tooltip>
                  <Tooltip value="Send now (stops current)" placement="top">
                    <IconButton
                      icon="arrow-up"
                      variant="ghost"
                      onClick={() => props.onSendNow(message.id)}
                    />
                  </Tooltip>
                  <Tooltip value="Remove from queue" placement="top">
                    <IconButton
                      icon="trash"
                      variant="ghost"
                      onClick={() => props.onDelete(message.id)}
                    />
                  </Tooltip>
                </div>
              </div>
            </>
          )}
        </For>
      </div>
    </Show>
  )
}
