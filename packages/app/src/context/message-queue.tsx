import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createRoot, type Accessor } from "solid-js"
import type { Prompt, ImageAttachmentPart, ContextItem } from "@/context/prompt"

export interface QueuedMessage {
  id: string
  text: string
  prompt: Prompt
  imageAttachments: ImageAttachmentPart[]
  context: {
    activeTab: boolean
    items: ContextItem[]
  }
  timestamp: number
}

type QueueStore = {
  queues: Record<string, QueuedMessage[]>
}

const sharedQueueStore = createRoot(() => {
  const [store, setStore] = createStore<QueueStore>({
    queues: {},
  })
  return { store, setStore }
})

export const { use: useMessageQueue, provider: MessageQueueProvider } = createSimpleContext<
  ReturnType<typeof createMessageQueueContext>,
  { paneId?: string }
>({
  name: "MessageQueue",
  init: (props) => createMessageQueueContext(() => props?.paneId),
})

function createMessageQueueContext(paneId?: string | Accessor<string | undefined>) {
  const getPaneId = typeof paneId === "function" ? paneId : () => paneId

  const queue = createMemo(() => {
    const id = getPaneId()
    if (!id) return []
    return sharedQueueStore.store.queues[id] ?? []
  })

  const add = (message: Omit<QueuedMessage, "id">) => {
    const id = getPaneId()
    if (!id) return
    const newMessage: QueuedMessage = {
      ...message,
      id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    }
    sharedQueueStore.setStore(
      produce((draft) => {
        if (!draft.queues[id]) {
          draft.queues[id] = []
        }
        draft.queues[id].push(newMessage)
      }),
    )
  }

  const remove = (messageId: string) => {
    const id = getPaneId()
    if (!id) return
    sharedQueueStore.setStore(
      produce((draft) => {
        const q = draft.queues[id]
        if (!q) return
        const index = q.findIndex((m) => m.id === messageId)
        if (index !== -1) {
          q.splice(index, 1)
        }
      }),
    )
  }

  const shift = (): QueuedMessage | undefined => {
    const id = getPaneId()
    if (!id) return undefined
    const q = sharedQueueStore.store.queues[id]
    if (!q || q.length === 0) return undefined
    const first = q[0]
    sharedQueueStore.setStore(
      produce((draft) => {
        const queue = draft.queues[id]
        if (queue && queue.length > 0) {
          queue.shift()
        }
      }),
    )
    return first
  }

  const get = (messageId: string): QueuedMessage | undefined => {
    const id = getPaneId()
    if (!id) return undefined
    const q = sharedQueueStore.store.queues[id]
    return q?.find((m) => m.id === messageId)
  }

  const clear = () => {
    const id = getPaneId()
    if (!id) return
    sharedQueueStore.setStore("queues", id, [])
  }

  return {
    queue,
    add,
    remove,
    shift,
    get,
    clear,
  }
}
