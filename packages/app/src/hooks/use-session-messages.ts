import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "@/context/sync"
import type { UserMessage } from "@opencode-ai/sdk/v2"

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export interface UseSessionMessagesOptions {
  sessionId: Accessor<string | undefined>
  windowSize?: Accessor<number>
}

export interface UseSessionMessagesReturn {
  messages: Accessor<UserMessage[]>
  userMessages: Accessor<UserMessage[]>
  visibleUserMessages: Accessor<UserMessage[]>
  lastUserMessage: Accessor<UserMessage | undefined>
  activeMessage: Accessor<UserMessage | undefined>
  setActiveMessage: (message: UserMessage | undefined) => void
  navigateByOffset: (offset: number) => void
  resetToLast: () => void
}

export function useSessionMessages(options: UseSessionMessagesOptions): UseSessionMessagesReturn {
  const sync = useSync()

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
  })

  const emptyUserMessages: UserMessage[] = []

  const messages = createMemo(() => {
    const id = options.sessionId()
    return id ? (sync.data.message[id] ?? []) : []
  })

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const revertMessageID = createMemo(() => {
    const id = options.sessionId()
    const info = id ? sync.session.get(id) : undefined
    return info?.revert?.messageID
  })

  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      const list = revert ? userMessages().filter((m) => m.id < revert) : userMessages()
      const limit = options.windowSize?.() ?? Number.POSITIVE_INFINITY
      if (limit <= 0) return emptyUserMessages
      if (list.length <= limit) return list
      return list.slice(list.length - limit)
    },
    emptyUserMessages,
    { equals: same },
  )

  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  const activeMessage = createMemo(() => {
    if (!store.messageId) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === store.messageId)
    return found ?? lastUserMessage()
  })

  function setActiveMessage(message: UserMessage | undefined) {
    setStore("messageId", message?.id)
  }

  function navigateByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = activeMessage()
    const currentIndex = current ? msgs.findIndex((m) => m.id === current.id) : -1

    let targetIndex: number
    if (currentIndex === -1) {
      targetIndex = offset > 0 ? 0 : msgs.length - 1
    } else {
      targetIndex = currentIndex + offset
    }

    if (targetIndex < 0 || targetIndex >= msgs.length) return

    setActiveMessage(msgs[targetIndex])
  }

  function resetToLast() {
    setStore("messageId", undefined)
  }

  return {
    messages: userMessages,
    userMessages,
    visibleUserMessages,
    lastUserMessage,
    activeMessage,
    setActiveMessage,
    navigateByOffset,
    resetToLast,
  }
}
