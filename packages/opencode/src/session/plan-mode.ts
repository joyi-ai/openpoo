import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { SessionPrompt } from "./prompt"
import z from "zod"

export namespace PlanMode {
  const log = Log.create({ service: "plan-mode" })

  export const Request = z.object({
    id: Identifier.schema("permission"),
    sessionID: z.string(),
    messageID: z.string(),
    callID: z.string(),
    plan: z.string(),
  })
  export type Request = z.infer<typeof Request>

  export const Response = z.object({
    requestID: z.string(),
    approved: z.boolean(),
  })
  export type Response = z.infer<typeof Response>

  export const Event = {
    PlanReview: BusEvent.define("planmode.review", Request),
    PlanResponded: BusEvent.define("planmode.responded", Response),
    PlanRejected: BusEvent.define(
      "planmode.rejected",
      z.object({
        requestID: z.string(),
      }),
    ),
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user rejected this plan")
    }
  }

  interface PendingPlan {
    info: Request
    resolve: (approved: boolean) => void
    reject: (e: Error) => void
  }

  const pending: Map<string, PendingPlan> = new Map()

  /**
   * Create a pending plan review and wait for user response
   */
  export async function review(input: {
    sessionID: string
    messageID: string
    callID: string
    plan: string
  }): Promise<boolean> {
    const id = Identifier.ascending("permission")
    const request: Request = {
      id,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      plan: input.plan,
    }

    log.info("creating plan review request", { id, sessionID: input.sessionID })

    return new Promise((resolve, reject) => {
      pending.set(id, {
        info: request,
        resolve,
        reject,
      })
      Bus.publish(Event.PlanReview, request)
    })
  }

  /**
   * Reply to a pending plan review
   */
  export function reply(input: { requestID: string; approved: boolean }): boolean {
    const pendingPlan = pending.get(input.requestID)
    if (!pendingPlan) {
      log.warn("no pending plan found", { requestID: input.requestID })
      return false
    }

    log.info("replying to plan review", { requestID: input.requestID, approved: input.approved })

    pending.delete(input.requestID)
    Bus.publish(Event.PlanResponded, {
      requestID: input.requestID,
      approved: input.approved,
    })
    pendingPlan.resolve(input.approved)
    if (!input.approved) return true
    SessionPrompt.cancel(pendingPlan.info.sessionID)
    return true
  }

  /**
   * Reject a pending plan review (user explicitly rejected the plan)
   */
  export function reject(requestID: string): boolean {
    const pendingPlan = pending.get(requestID)
    if (!pendingPlan) {
      log.warn("no pending plan found for rejection", { requestID })
      return false
    }

    log.info("rejecting plan review", { requestID })
    pending.delete(requestID)
    Bus.publish(Event.PlanRejected, { requestID })
    pendingPlan.reject(new RejectedError())
    return true
  }

  /**
   * Cancel a pending plan review
   */
  export function cancel(requestID: string): boolean {
    const pendingPlan = pending.get(requestID)
    if (!pendingPlan) return false

    log.info("cancelling plan review", { requestID })
    pending.delete(requestID)
    pendingPlan.reject(new Error("Plan review cancelled"))
    return true
  }

  /**
   * Cancel all pending plan reviews for a session
   */
  export function cancelSession(sessionID: string): void {
    for (const [id, plan] of pending) {
      if (plan.info.sessionID === sessionID) {
        log.info("cancelling plan review for session", { id, sessionID })
        pending.delete(id)
        plan.reject(new Error("Session cancelled"))
      }
    }
  }

  /**
   * List all pending plan reviews
   */
  export function list(): Request[] {
    return Array.from(pending.values()).map((p) => p.info)
  }

  /**
   * List pending plan reviews for a specific session
   */
  export function listForSession(sessionID: string): Request[] {
    return Array.from(pending.values())
      .filter((p) => p.info.sessionID === sessionID)
      .map((p) => p.info)
  }
}
