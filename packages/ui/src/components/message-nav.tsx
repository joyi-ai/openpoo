import { UserMessage } from "@opencode-ai/sdk/v2"
import { ComponentProps, For, Match, Show, splitProps, Switch } from "solid-js"
import { DiffChanges } from "./diff-changes"
import { Tooltip } from "@kobalte/core/tooltip"
import { useI18n } from "../context/i18n"

export function MessageNav(
  props: ComponentProps<"ul"> & {
    messages: UserMessage[]
    current?: UserMessage
    size: "normal" | "compact"
    onMessageSelect: (message: UserMessage) => void
    getLabel?: (message: UserMessage) => string | undefined
  },
) {
  const i18n = useI18n()
  const [local, others] = splitProps(props, ["messages", "current", "size", "onMessageSelect", "getLabel"])
  const compactLimit = 4

  function compactMessages(messages: UserMessage[], current: UserMessage | undefined) {
    if (messages.length <= compactLimit) return messages

    const currentId = current?.id
    if (!currentId) return messages.slice(-compactLimit)

    const currentIndex = messages.findIndex((message) => message.id === currentId)
    if (currentIndex === -1) return messages.slice(-compactLimit)

    const maxStart = messages.length - compactLimit
    const start = Math.max(0, Math.min(currentIndex - (compactLimit - 1), maxStart))
    return messages.slice(start, start + compactLimit)
  }

  const content = () => (
    <ul role="list" data-component="message-nav" data-size={local.size} {...others}>
      <For each={local.size === "compact" ? compactMessages(local.messages, local.current) : local.messages}>
        {(message) => {
          const handleClick = () => local.onMessageSelect(message)

          return (
            <li data-slot="message-nav-item">
              <Switch>
                <Match when={local.size === "compact"}>
                  <button
                    type="button"
                    data-slot="message-nav-tick-button"
                    data-active={message.id === local.current?.id || undefined}
                    onClick={handleClick}
                  >
                    <div data-slot="message-nav-tick-line" />
                  </button>
                </Match>
                <Match when={local.size === "normal"}>
                  <button data-slot="message-nav-message-button" onClick={handleClick}>
                    <DiffChanges changes={message.summary?.diffs ?? []} variant="bars" />
                    <div
                      data-slot="message-nav-title-preview"
                      data-active={message.id === local.current?.id || undefined}
                    >
                      <Show
                        when={local.getLabel?.(message) ?? message.summary?.title}
                        fallback={i18n.t("ui.messageNav.newMessage")}
                      >
                        {local.getLabel?.(message) ?? message.summary?.title}
                      </Show>
                    </div>
                  </button>
                </Match>
              </Switch>
            </li>
          )
        }}
      </For>
    </ul>
  )

  return (
    <Switch>
      <Match when={local.size === "compact"}>
        <Tooltip openDelay={0} closeDelay={300} placement="right-start" gutter={-40} shift={-10} overlap>
          <Tooltip.Trigger as="div">{content()}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content data-slot="message-nav-tooltip">
              <div data-slot="message-nav-tooltip-content">
                <MessageNav {...props} size="normal" class="" />
              </div>
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip>
      </Match>
      <Match when={local.size === "normal"}>{content()}</Match>
    </Switch>
  )
}
