import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Button } from "@opencode-ai/ui/button"
import { useParams } from "@solidjs/router"
import { AssistantMessage } from "@opencode-ai/sdk/v2/client"

import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { makeContextKey } from "@/utils/layout-key"
import { useLanguage } from "@/context/language"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  sessionId?: string
  contextKey?: string
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const params = useParams()
  const layout = useLayout()
  const sdk = useSDK()
  const language = useLanguage()

  const effectiveSessionId = createMemo(() => props.sessionId ?? params.id)
  const variant = createMemo(() => props.variant ?? "button")
  const contextKey = createMemo(() => props.contextKey ?? makeContextKey({ directory: sdk.directory }))
  const tabs = createMemo(() => layout.tabs(contextKey()))
  const messages = createMemo(() => (effectiveSessionId() ? (sync.data.message[effectiveSessionId()!] ?? []) : []))

  const cost = createMemo(() => {
    const locale = language.locale()
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const locale = language.locale()
    const last = messages().findLast((x) => {
      if (x.role !== "assistant") return false
      const total = x.tokens.input + x.tokens.output + x.tokens.reasoning + x.tokens.cache.read + x.tokens.cache.write
      return total > 0
    }) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.all.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(locale),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const isContextOpen = createMemo(() => tabs().active() === "context")

  const toggleContext = () => {
    if (!effectiveSessionId()) return
    if (isContextOpen()) {
      tabs().setActive(undefined)
    } else {
      tabs().open("context")
      tabs().setActive("context")
    }
  }

  const circle = () => (
    <div class="p-1">
      <ProgressCircle size={16} strokeWidth={2} percentage={context()?.percentage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div>
      <Show when={context()}>
        {(ctx) => (
          <>
            <div class="flex items-center gap-2">
              <span class="text-text-strong">{ctx().tokens}</span>
              <span class="text-text-base">{language.t("context.usage.tokens")}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-text-strong">{ctx().percentage ?? 0}%</span>
              <span class="text-text-base">{language.t("context.usage.usage")}</span>
            </div>
          </>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-strong">{cost()}</span>
        <span class="text-text-base">{language.t("context.usage.cost")}</span>
      </div>
      <Show when={variant() === "button"}>
        <div class="text-11-regular text-text-base mt-1">{language.t("context.usage.clickToView")}</div>
      </Show>
    </div>
  )

  return (
    <Show when={effectiveSessionId()}>
      <Tooltip value={tooltipValue()} placement="top">
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={toggleContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
