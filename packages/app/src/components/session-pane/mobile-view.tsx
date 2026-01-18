import { Show, For, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { Message } from "@opencode-ai/sdk/v2/client"

export interface MobileViewProps {
  sessionId?: string
  visibleUserMessages: Accessor<UserMessage[]>
  lastUserMessage: Accessor<UserMessage | undefined>
  working: Accessor<boolean>
  composerHeight: Accessor<number>
  scrollRef?: (el: HTMLElement | undefined) => void
  contentRef?: (el: HTMLElement | undefined) => void
  onUserInteracted?: () => void
  onScroll?: (e: Event) => void
  messageActions?: {
    onEdit?: (message: Message) => void
    onRestore?: (message: Message) => void
    onRetry?: (message: Message) => void
    onDelete?: (message: Message) => void
  }
  newSessionView: () => any
}

export function MobileView(props: MobileViewProps) {
  const [store, setStore] = createStore({
    mobileStepsExpanded: {} as Record<string, boolean>,
  })

  const MobileTurns = () => (
    <div
      ref={props.scrollRef}
      data-scroll-container="session-pane-mobile"
      class="relative mt-2 min-w-0 w-full h-full overflow-y-auto no-scrollbar"
      onScroll={props.onScroll}
    >
      <div
        ref={props.contentRef}
        class="flex flex-col gap-4 items-start justify-start mt-4"
      >
        <For each={props.visibleUserMessages()}>
          {(message) => (
            <div data-message-id={message.id} class="w-full mb-2">
              <SessionTurn
                sessionID={props.sessionId!}
                messageID={message.id}
                lastUserMessageID={props.lastUserMessage()?.id}
                stepsExpanded={store.mobileStepsExpanded[message.id] ?? false}
                onStepsExpandedToggle={() => setStore("mobileStepsExpanded", message.id, (x) => !x)}
                hideTitle={true}
                onUserInteracted={props.onUserInteracted}
                actions={props.messageActions}
                classes={{
                  root: "min-w-0 w-full relative",
                  content:
                    "flex flex-col justify-between !overflow-visible [&_[data-slot=session-turn-message-header]]:top-[-32px] [&_[data-slot=session-turn-message-content]]:!mt-0",
                  container: "px-4",
                }}
              />
            </div>
          )}
        </For>
      </div>
    </div>
  )

  return (
    <div class="md:hidden flex-1 min-h-0 flex flex-col bg-background-stronger">
      <Show when={props.sessionId} fallback={<div class="flex-1 min-h-0 overflow-hidden">{props.newSessionView()}</div>}>
        <div class="flex-1 min-h-0 overflow-hidden">
          <MobileTurns />
        </div>
      </Show>
    </div>
  )
}
