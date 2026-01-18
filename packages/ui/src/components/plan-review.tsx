import { Component, createMemo, createSignal, Show } from "solid-js"
import { Icon } from "./icon"
import { Markdown } from "./markdown"
import { Spinner } from "./spinner"
import type { ToolProps } from "./message-part"
import { useData } from "../context/data"
import "./plan-review.css"

interface ExitPlanModeInput {
  plan?: string
}

export interface PlanReviewProps extends ToolProps {
  sessionID?: string
  callID?: string
}

export const PlanReview: Component<PlanReviewProps> = (props) => {
  const data = useData()
  const input = () => props.input as ExitPlanModeInput

  // Find the pending plan review request that matches this tool call
  const pendingRequest = createMemo(() => {
    if (!props.sessionID || !props.callID) return undefined
    const requests = data.store.planmode?.[props.sessionID] ?? []
    return requests.find((r) => r.callID === props.callID)
  })

  // Get plan content from the pending request (which reads from PLAN.md) or fall back to tool input
  const plan = () => pendingRequest()?.plan ?? input()?.plan ?? ""

  // Track submission state
  const [isSubmitting, setIsSubmitting] = createSignal(false)
  const [submitted, setSubmitted] = createSignal<"approved" | "rejected" | null>(null)
  const [activeAction, setActiveAction] = createSignal<"approve" | "reject" | null>(null)

  const handleApprove = async () => {
    const request = pendingRequest()
    if (!request || !data.respondToPlanMode || isSubmitting()) return

    setIsSubmitting(true)
    setActiveAction("approve")
    try {
      const result = await data.respondToPlanMode({
        requestID: request.id,
        approved: true,
        sessionID: request.sessionID ?? props.sessionID,
        plan: plan(),
      })
      const nextSessionID = result?.sessionID
      if (nextSessionID && data.navigateToSession) {
        data.navigateToSession(nextSessionID)
      }
      // Switch to build agent after approval before showing completion state
      data.setAgent?.("build")
      setSubmitted("approved")
    } catch {
      setIsSubmitting(false)
      setActiveAction(null)
    }
  }

  const handleReject = async () => {
    const request = pendingRequest()
    if (!request || !data.respondToPlanMode || isSubmitting()) return

    setIsSubmitting(true)
    setActiveAction("reject")
    try {
      await data.respondToPlanMode({
        requestID: request.id,
        reject: true,
      })
      setSubmitted("rejected")
    } catch {
      setIsSubmitting(false)
      setActiveAction(null)
    }
  }

  // If already responded (completed status) or just submitted, show the result
  if (props.status === "completed" || submitted()) {
    const wasApproved = submitted() === "approved" || props.output?.includes("approved")
    return (
      <div data-component="plan-review" data-completed>
        <div data-slot="plan-review-response">
          <Show
            when={wasApproved}
            fallback={
              <>
                <Icon name="circle-ban-sign" size="small" class="text-icon-error-base" />
                <span>Plan rejected</span>
              </>
            }
          >
            <Icon name="check" size="small" class="text-icon-success-base" />
            <span>Plan approved</span>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div data-component="plan-review">
      <div data-slot="plan-review-header">
        <Icon name="checklist" size="small" class="text-icon-info-active" />
        <span>Plan Review</span>
      </div>
      <Show when={plan()}>
        <div data-slot="plan-review-content">
          <Markdown text={plan()} />
        </div>
      </Show>
      <div data-slot="plan-review-actions">
        <button
          type="button"
          data-slot="plan-review-reject-btn"
          data-submitting={isSubmitting() && activeAction() === "reject"}
          onClick={handleReject}
          disabled={isSubmitting()}
        >
          <Show when={isSubmitting() && activeAction() === "reject"}>
            <Spinner />
          </Show>
          {isSubmitting() && activeAction() === "reject" ? "Rejecting..." : "Reject"}
        </button>
        <button
          type="button"
          data-slot="plan-review-approve-btn"
          data-ready="true"
          data-submitting={isSubmitting() && activeAction() === "approve"}
          onClick={handleApprove}
          disabled={isSubmitting()}
        >
          <Show when={isSubmitting() && activeAction() === "approve"}>
            <Spinner />
          </Show>
          {isSubmitting() && activeAction() === "approve" ? "Approving..." : "Approve Plan"}
        </button>
      </div>
    </div>
  )
}
