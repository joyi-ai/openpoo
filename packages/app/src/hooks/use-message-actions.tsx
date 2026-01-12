import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { showToast } from "@opencode-ai/ui/toast"
import { Identifier } from "@/utils/id"
import { extractPromptFromParts } from "@/utils/prompt"
import type { AgentPart, FilePart, Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"

type PromptPart =
  | {
      id: string
      type: "text"
      text: string
    }
  | {
      id: string
      type: "file"
      mime: string
      url: string
      filename?: string
      source?: FilePart["source"]
    }
  | {
      id: string
      type: "agent"
      name: string
      source?: AgentPart["source"]
    }

function isUserMessage(message: Message): message is UserMessage {
  return message.role === "user"
}

function buildPromptParts(parts: Part[]) {
  const list: PromptPart[] = []
  for (const part of parts) {
    if (part.type === "text") {
      if (part.synthetic) continue
      if (part.ignored) continue
      list.push({
        id: Identifier.ascending("part"),
        type: "text",
        text: part.text,
      })
    }
    if (part.type === "file") {
      list.push({
        id: Identifier.ascending("part"),
        type: "file",
        mime: part.mime,
        url: part.url,
        filename: part.filename,
        source: part.source,
      })
    }
    if (part.type === "agent") {
      list.push({
        id: Identifier.ascending("part"),
        type: "agent",
        name: part.name,
        source: part.source,
      })
    }
  }
  return list
}

export function useMessageActions() {
  const sync = useSync()
  const sdk = useSDK()
  const prompt = usePrompt()
  const local = useLocal()

  const modePayload = () => {
    const current = local.mode.current()
    if (!current) return undefined
    return {
      id: current.id,
    }
  }

  const abortIfBusy = async (sessionID: string) => {
    const status = sync.data.session_status[sessionID]
    if (status?.type === "idle") return
    await sdk.client.session.abort({ sessionID }).catch(() => {})
  }

  const editMessage = async (message: Message) => {
    if (!isUserMessage(message)) return
    await abortIfBusy(message.sessionID)
    const parts = sync.data.part[message.id] ?? []
    prompt.set(extractPromptFromParts(parts))
    prompt.action.set({
      sessionID: message.sessionID,
      messageID: message.id,
      agent: message.agent,
      model: message.model,
      variant: message.variant,
      system: message.system,
      thinking: message.thinking,
      claudeCodeFlow: message.claudeCodeFlow,
    })
    if (message.agent) local.agent.set(message.agent)
    if (message.model) local.model.set(message.model)
    local.model.variant.set(message.variant)
    if (message.thinking !== undefined) local.model.thinking.set(message.thinking)
  }

  const retryMessage = async (message: Message) => {
    if (!isUserMessage(message)) return
    await abortIfBusy(message.sessionID)
    prompt.action.clear()
    const parts = sync.data.part[message.id] ?? []
    const promptParts = buildPromptParts(parts)
    if (promptParts.length === 0) {
      showToast({
        variant: "error",
        title: "Nothing to retry",
        description: "This message has no prompt content to resend.",
      })
      return
    }
    const reverted = await sdk.client.session
      .revert({ sessionID: message.sessionID, messageID: message.id })
      .then(() => true)
      .catch((e) => {
        showToast({
          variant: "error",
          title: "Failed to retry message",
          description: e.message ?? "Please try again.",
        })
        return false
      })
    if (!reverted) return
    const messageID = Identifier.ascending("message")
    const optimistic = promptParts.map((part) => ({
      ...part,
      sessionID: message.sessionID,
      messageID,
    }))
    sync.session.addOptimisticMessage({
      sessionID: message.sessionID,
      messageID,
      parts: optimistic,
      agent: message.agent,
      model: message.model,
    })
    sdk.client.session
      .prompt({
        sessionID: message.sessionID,
        agent: message.agent,
        model: message.model,
        messageID,
        parts: promptParts,
        variant: message.variant,
        system: message.system,
        thinking: message.thinking,
        claudeCodeFlow: message.claudeCodeFlow,
        mode: modePayload(),
      })
      .then((response) => {
        const data = response.data
        if (!data) return
        sync.session.mergeMessage({ info: data.info, parts: data.parts ?? [] })
      })
      .catch((e) => {
        showToast({
          variant: "error",
          title: "Failed to retry message",
          description: e.message ?? "Please try again.",
        })
      })
  }

  const deleteMessage = async (message: Message) => {
    if (!isUserMessage(message)) return
    await abortIfBusy(message.sessionID)
    prompt.action.clear()
    const reverted = await sdk.client.session
      .revert({ sessionID: message.sessionID, messageID: message.id })
      .then(() => true)
      .catch((e) => {
        showToast({
          variant: "error",
          title: "Failed to delete message",
          description: e.message ?? "Please try again.",
        })
        return false
      })
    if (!reverted) return
    await sdk.client.session.summarize({ sessionID: message.sessionID }).catch((e) => {
      showToast({
        variant: "error",
        title: "Failed to finalize deletion",
        description: e.message ?? "Please try again.",
      })
    })
  }

  return {
    editMessage,
    retryMessage,
    deleteMessage,
  }
}
