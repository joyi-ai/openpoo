import type { Message, Session, Part, FileDiff, SessionStatus, PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "./helper"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

type AskUserRequest = {
  id: string
  callID: string
  source?: "askuser" | "question"
}

type PlanModeRequest = {
  id: string
  sessionID: string
  messageID: string
  callID: string
  plan: string
}

type Data = {
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  permission?: {
    [sessionID: string]: PermissionRequest[]
  }
  askuser?: {
    [sessionID: string]: AskUserRequest[]
  }
  planmode?: {
    [sessionID: string]: PlanModeRequest[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
}) => void

export type NavigateToSessionFn = (sessionID: string) => void

export type AskUserRespondFn = (input: {
  requestID: string
  answers: Record<string, string>
  answerSets?: string[][]
  sessionID?: string
  source?: "askuser" | "question"
  reject?: boolean
}) => Promise<unknown>

export type PlanModeRespondResult = {
  sessionID?: string
}

export type PlanModeRespondFn = (input: {
  requestID: string
  approved?: boolean
  reject?: boolean
  sessionID?: string
  plan?: string
}) => Promise<PlanModeRespondResult | undefined>

export type SetAgentFn = (name: string) => void

export type PrefetchReasoningFn = (input: { sessionID: string; messageID: string }) => Promise<unknown> | void

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onPermissionRespond?: PermissionRespondFn
    onNavigateToSession?: NavigateToSessionFn
    onAskUserRespond?: AskUserRespondFn
    onPlanModeRespond?: PlanModeRespondFn
    onSetAgent?: SetAgentFn
    onReasoningPrefetch?: PrefetchReasoningFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      respondToPermission: props.onPermissionRespond,
      navigateToSession: props.onNavigateToSession,
      respondToAskUser: props.onAskUserRespond,
      respondToPlanMode: props.onPlanModeRespond,
      setAgent: props.onSetAgent,
      prefetchReasoning: props.onReasoningPrefetch,
    }
  },
})
