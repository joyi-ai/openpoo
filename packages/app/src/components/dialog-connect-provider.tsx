import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { iife } from "@opencode-ai/util/iife"
import { createMemo, createResource, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { DialogSelectModel } from "./dialog-select-model"
import { DialogSelectProvider } from "./dialog-select-provider"

type RoutingSettings = {
  order?: string[]
  allow_fallbacks?: boolean
  require_parameters?: boolean
  data_collection?: "allow" | "deny"
  only?: string[]
}

export function DialogConnectProvider(props: { provider: string; onBack?: () => void }) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const providers = useProviders()
  const provider = createMemo(() => globalSync.data.provider.all.find((x) => x.id === props.provider)!)
  const iconId = createMemo(() => (props.provider === "codex" ? "openai" : props.provider))
  const isConnected = createMemo(() => providers.connected().some((p) => p.id === props.provider))
  const supportsRouting = createMemo(() => props.provider === "openrouter" || props.provider === "vercel")

  // Fetch existing routing settings for this provider
  const [routingSettings, { refetch: refetchRouting }] = createResource(
    () => (supportsRouting() ? props.provider : null),
    async (providerId) => {
      if (!providerId) return null
      const response = await fetch(`${globalSDK.url}/provider/${providerId}/routing`)
      if (!response.ok) return null
      const data = await response.json()
      return data as RoutingSettings | null
    },
  )

  const methods = createMemo(
    () =>
      globalSync.data.provider_auth[props.provider] ?? [
        {
          type: "api",
          label: "API key",
        },
      ],
  )

  // Fetch existing auth info for this provider
  const [existingAuth] = createResource(
    () => props.provider,
    async (providerId) => {
      const response = await fetch(`${globalSDK.url}/auth/${providerId}`)
      if (!response.ok) return null
      const data = await response.json()
      return data as { type: string } | null
    },
  )

  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    state: "pending" as undefined | "pending" | "complete" | "error",
    error: undefined as string | undefined,
  })

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex!) : undefined))

  async function selectMethod(index: number) {
    const method = methods()[index]
    setStore(
      produce((draft) => {
        draft.methodIndex = index
        draft.authorization = undefined
        draft.state = undefined
        draft.error = undefined
      }),
    )

    if (method.type === "oauth") {
      setStore("state", "pending")
      const start = Date.now()
      await globalSDK.client.provider.oauth
        .authorize(
          {
            providerID: props.provider,
            method: index,
          },
          { throwOnError: true },
        )
        .then((x) => {
          const elapsed = Date.now() - start
          const delay = 1000 - elapsed

          if (delay > 0) {
            setTimeout(() => {
              setStore("state", "complete")
              setStore("authorization", x.data!)
            }, delay)
            return
          }
          setStore("state", "complete")
          setStore("authorization", x.data!)
        })
        .catch((e) => {
          setStore("state", "error")
          setStore("error", String(e))
        })
    }
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  function normalizeOauthCode(input: string) {
    const trimmed = input.trim()
    if (!trimmed) return undefined
    const codeMatch = trimmed.match(/(?:^|[?&#])code=([^&#]+)/i)
    const stateMatch = trimmed.match(/(?:^|[?&#])state=([^&#]+)/i)
    const code = codeMatch?.[1]
    const state = stateMatch?.[1]
    if (code && state) return `${code}#${state}`
    if (code) return code
    return trimmed
  }

  onMount(() => {
    if (methods().length === 1) {
      selectMethod(0)
    }
    document.addEventListener("keydown", handleKey)
    onCleanup(() => {
      document.removeEventListener("keydown", handleKey)
    })
  })

  async function complete() {
    await globalSDK.client.global.dispose()
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: `${provider().name} connected`,
      description: `${provider().name} models are now available to use.`,
    })
  }

  function goBack() {
    // If we have nested state, go back one level
    if (store.authorization) {
      setStore("authorization", undefined)
      setStore("methodIndex", undefined)
      return
    }
    if (store.methodIndex !== undefined && methods().length > 1) {
      setStore("methodIndex", undefined)
      return
    }
    // Otherwise, use custom onBack or default to DialogSelectProvider
    if (props.onBack) {
      props.onBack()
      return
    }
    dialog.show(() => <DialogSelectProvider />)
  }

  return (
    <Dialog title={<IconButton tabIndex={-1} icon="arrow-left" variant="ghost" onClick={goBack} />}>
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id={iconId() as IconName} class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">
            <Switch>
              <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
                Login with Claude Pro/Max
              </Match>
              <Match when={true}>Connect {provider().name}</Match>
            </Switch>
          </div>
        </div>
        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <Switch>
            <Match when={store.methodIndex === undefined}>
              <div class="text-14-regular text-text-base">Select login method for {provider().name}.</div>
              <div class="">
                <List
                  ref={(ref) => {
                    listRef = ref
                  }}
                  items={methods}
                  key={(m) => m?.label}
                  onSelect={async (method, index) => {
                    if (!method) return
                    selectMethod(index)
                  }}
                >
                  {(i) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{i.label}</span>
                    </div>
                  )}
                </List>
              </div>
            </Match>
            <Match when={store.state === "pending"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Spinner />
                  <span>Authorization in progress...</span>
                </div>
              </div>
            </Match>
            <Match when={store.state === "error"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Icon name="circle-ban-sign" class="text-icon-critical-base" />
                  <span>Authorization failed: {store.error}</span>
                </div>
              </div>
            </Match>
            <Match when={method()?.type === "api"}>
              {iife(() => {
                const [formStore, setFormStore] = createStore({
                  value: "",
                  error: undefined as string | undefined,
                })

                const hasExistingKey = createMemo(() => existingAuth()?.type === "api")

                async function handleSubmit(e: SubmitEvent) {
                  e.preventDefault()

                  const form = e.currentTarget as HTMLFormElement
                  const formData = new FormData(form)
                  const apiKey = formData.get("apiKey") as string

                  if (!apiKey?.trim()) {
                    setFormStore("error", "API key is required")
                    return
                  }

                  setFormStore("error", undefined)
                  await globalSDK.client.auth.set({
                    providerID: props.provider,
                    auth: {
                      type: "api",
                      key: apiKey,
                    },
                  })
                  await complete()
                }

                return (
                  <div class="flex flex-col gap-6">
                    <Switch>
                      <Match when={provider().id === "opencode"}>
                        <div class="flex flex-col gap-4">
                          <div class="text-14-regular text-text-base">
                            OpenCode Zen gives you access to a curated set of reliable optimized models for coding
                            agents.
                          </div>
                          <div class="text-14-regular text-text-base">
                            With a single API key you'll get access to models such as Claude, GPT, Gemini, GLM and more.
                          </div>
                          <div class="text-14-regular text-text-base">
                            Visit{" "}
                            <Link href="https://opencode.ai/zen" tabIndex={-1}>
                              opencode.ai/zen
                            </Link>{" "}
                            to collect your API key.
                          </div>
                        </div>
                      </Match>
                      <Match when={hasExistingKey()}>
                        <div class="text-14-regular text-text-base">
                          {provider().name} is already connected. You can update your API key below or keep using the
                          existing one.
                        </div>
                      </Match>
                      <Match when={true}>
                        <div class="text-14-regular text-text-base">
                          Enter your {provider().name} API key to connect your account and use {provider().name} models
                          in OpenCode.
                        </div>
                      </Match>
                    </Switch>
                    <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
                      <div class="w-full flex items-end gap-2">
                        <TextField
                          autofocus={!hasExistingKey()}
                          type="text"
                          label={`${provider().name} API key`}
                          placeholder={hasExistingKey() ? "Enter new API key to replace" : "API key"}
                          name="apiKey"
                          value={formStore.value}
                          onChange={(v) => setFormStore("value", v)}
                          validationState={formStore.error ? "invalid" : undefined}
                          error={formStore.error}
                          class="flex-1"
                        />
                      </div>
                      <div class="flex items-center gap-3">
                        <Button
                          class="w-auto"
                          type="submit"
                          size="large"
                          variant="primary"
                          disabled={!!(hasExistingKey() && !formStore.value)}
                        >
                          {hasExistingKey() ? "Update" : "Submit"}
                        </Button>
                        <Show when={hasExistingKey() && !formStore.value}>
                          <Button
                            class="w-auto"
                            type="button"
                            size="large"
                            variant="ghost"
                            onClick={() => dialog.close()}
                          >
                            Keep existing
                          </Button>
                        </Show>
                      </div>
                    </form>

                    {/* Provider Routing Settings */}
                    <Show when={supportsRouting() && isConnected()}>
                      {iife(() => {
                        const [routingProviders] = createResource(async () => {
                          const res = await fetch(`${globalSDK.url}/provider/routing/providers`)
                          return res.json() as Promise<{ openrouter: string[]; vercel: string[] }>
                        })

                        const availableProviders = () => {
                          const data = routingProviders()
                          if (!data) return []
                          return props.provider === "openrouter" ? data.openrouter : data.vercel
                        }

                        const [routingStore, setRoutingStore] = createStore<{
                          order: string[]
                          allow_fallbacks: boolean
                          data_collection: "allow" | "deny"
                          only: string[]
                          dirty: boolean
                          saving: boolean
                        }>({
                          order: routingSettings()?.order ?? [],
                          allow_fallbacks: routingSettings()?.allow_fallbacks ?? true,
                          data_collection: routingSettings()?.data_collection ?? "allow",
                          only: routingSettings()?.only ?? [],
                          dirty: false,
                          saving: false,
                        })

                        const addProvider = (name: string) => {
                          if (routingStore.order.includes(name)) return
                          setRoutingStore("order", [...routingStore.order, name])
                          setRoutingStore("dirty", true)
                        }

                        const removeProvider = (name: string) => {
                          setRoutingStore(
                            "order",
                            routingStore.order.filter((p) => p !== name),
                          )
                          setRoutingStore("dirty", true)
                        }

                        const moveProvider = (index: number, direction: -1 | 1) => {
                          const newOrder = [...routingStore.order]
                          const newIndex = index + direction
                          if (newIndex < 0 || newIndex >= newOrder.length) return
                          ;[newOrder[index], newOrder[newIndex]] = [newOrder[newIndex], newOrder[index]]
                          setRoutingStore("order", newOrder)
                          setRoutingStore("dirty", true)
                        }

                        const saveRouting = async () => {
                          setRoutingStore("saving", true)
                          try {
                            await fetch(`${globalSDK.url}/provider/${props.provider}/routing`, {
                              method: "PUT",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                order: routingStore.order.length > 0 ? routingStore.order : undefined,
                                allow_fallbacks: routingStore.allow_fallbacks,
                                data_collection: routingStore.data_collection,
                                only: routingStore.only.length > 0 ? routingStore.only : undefined,
                              }),
                            })
                            setRoutingStore("dirty", false)
                            showToast({
                              variant: "success",
                              title: "Routing settings saved",
                            })
                            refetchRouting()
                          } catch {
                            showToast({
                              variant: "error",
                              title: "Failed to save routing settings",
                            })
                          } finally {
                            setRoutingStore("saving", false)
                          }
                        }

                        return (
                          <div class="border-t border-border-base pt-6 flex flex-col gap-4">
                            <div class="text-14-medium text-text-strong">Provider Routing</div>
                            <div class="text-13-regular text-text-weak">
                              Configure which upstream providers to use and in what order.
                            </div>

                            {/* Provider Order */}
                            <div class="flex flex-col gap-2">
                              <div class="text-13-medium text-text-base">Provider Order</div>
                              <Show
                                when={routingStore.order.length > 0}
                                fallback={
                                  <div class="text-12-regular text-text-weak py-2">
                                    No provider order set. Using default routing.
                                  </div>
                                }
                              >
                                <div class="flex flex-col gap-1">
                                  <For each={routingStore.order}>
                                    {(name, index) => (
                                      <div class="flex items-center gap-2 py-1.5 px-2 rounded bg-surface-raised-base">
                                        <span class="text-13-regular text-text-base flex-1">{name}</span>
                                        <button
                                          type="button"
                                          class="p-1 rounded hover:bg-surface-raised-base-hover disabled:opacity-30"
                                          disabled={index() === 0}
                                          onClick={() => moveProvider(index(), -1)}
                                        >
                                          <Icon name="chevron-down" size="small" class="rotate-180" />
                                        </button>
                                        <button
                                          type="button"
                                          class="p-1 rounded hover:bg-surface-raised-base-hover disabled:opacity-30"
                                          disabled={index() === routingStore.order.length - 1}
                                          onClick={() => moveProvider(index(), 1)}
                                        >
                                          <Icon name="chevron-down" size="small" />
                                        </button>
                                        <button
                                          type="button"
                                          class="p-1 rounded hover:bg-surface-raised-base-hover"
                                          onClick={() => removeProvider(name)}
                                        >
                                          <Icon name="close" size="small" />
                                        </button>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </Show>

                              {/* Add provider dropdown */}
                              <div class="flex flex-wrap gap-1 pt-1">
                                <For each={availableProviders().filter((p) => !routingStore.order.includes(p))}>
                                  {(name) => (
                                    <button
                                      type="button"
                                      class="px-2 py-1 text-12-regular text-text-weak rounded border border-border-weak-base hover:bg-surface-raised-base-hover hover:text-text-base transition-colors"
                                      onClick={() => addProvider(name)}
                                    >
                                      + {name}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </div>

                            {/* OpenRouter-specific options */}
                            <Show when={props.provider === "openrouter"}>
                              <div class="flex flex-col gap-3 pt-2">
                                <Checkbox
                                  checked={routingStore.allow_fallbacks}
                                  onChange={(checked) => {
                                    setRoutingStore("allow_fallbacks", checked)
                                    setRoutingStore("dirty", true)
                                  }}
                                >
                                  Allow fallbacks to other providers
                                </Checkbox>
                                <Checkbox
                                  checked={routingStore.data_collection === "deny"}
                                  onChange={(checked) => {
                                    setRoutingStore("data_collection", checked ? "deny" : "allow")
                                    setRoutingStore("dirty", true)
                                  }}
                                >
                                  Deny data collection for training
                                </Checkbox>
                              </div>
                            </Show>

                            <Show when={routingStore.dirty}>
                              <Button
                                class="self-start"
                                variant="primary"
                                size="small"
                                onClick={saveRouting}
                                disabled={routingStore.saving}
                              >
                                {routingStore.saving ? "Saving..." : "Save Routing Settings"}
                              </Button>
                            </Show>
                          </div>
                        )
                      })}
                    </Show>
                  </div>
                )
              })}
            </Match>
            <Match when={method()?.type === "oauth"}>
              <Switch>
                <Match when={store.authorization?.method === "code"}>
                  {iife(() => {
                    const [formStore, setFormStore] = createStore({
                      value: "",
                      error: undefined as string | undefined,
                      submitting: false,
                    })

                    onMount(() => {
                      if (store.authorization?.method === "code" && store.authorization?.url) {
                        platform.openLink(store.authorization.url)
                      }
                    })

                    function extractErrorMessage(error: unknown): string {
                      if (!error || typeof error !== "object") return "Invalid authorization code"
                      const err = error as Record<string, unknown>

                      // Handle BadRequestError format: { data: unknown, errors: Array<{...}>, success: false }
                      if (Array.isArray(err.errors) && err.errors.length > 0) {
                        const firstError = err.errors[0] as Record<string, unknown>
                        // Check for name field (e.g., ProviderAuthOauthMissing, ProviderAuthOauthCodeMissing, etc.)
                        if (typeof firstError.name === "string") {
                          const name = firstError.name
                          if (name === "ProviderAuthOauthMissing") {
                            return "Authorization session expired. Please start the login process again."
                          }
                          if (name === "ProviderAuthOauthCodeMissing") {
                            return "Authorization code is required"
                          }
                          if (name === "ProviderAuthOauthCallbackFailed") {
                            return "Authorization failed. Please check the code and try again."
                          }
                          // Format error name for display
                          return name.replace(/([A-Z])/g, " $1").trim()
                        }
                        // Check for message field
                        if (typeof firstError.message === "string") {
                          return firstError.message
                        }
                      }

                      if (error instanceof Error) {
                        const name = error.name
                        if (name === "ProviderAuthOauthMissing") {
                          return "Authorization session expired. Please start the login process again."
                        }
                        if (name === "ProviderAuthOauthCodeMissing") {
                          return "Authorization code is required"
                        }
                        if (name === "ProviderAuthOauthCallbackFailed") {
                          return "Authorization failed. Please check the code and try again."
                        }
                        if (error.message) return error.message
                        return "Invalid authorization code"
                      }

                      // Handle NamedError format: { name: string, data: object }
                      if (typeof err.name === "string") {
                        if (err.name === "ProviderAuthOauthMissing") {
                          return "Authorization session expired. Please start the login process again."
                        }
                        if (err.name === "ProviderAuthOauthCodeMissing") {
                          return "Authorization code is required"
                        }
                        if (err.name === "ProviderAuthOauthCallbackFailed") {
                          return "Authorization failed. Please check the code and try again."
                        }
                        return err.name.replace(/([A-Z])/g, " $1").trim()
                      }

                      // Handle error with message property
                      if (typeof err.message === "string") {
                        return err.message
                      }

                      return "Invalid authorization code"
                    }

                    function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
                      return Promise.race([
                        promise,
                        new Promise<T>((_, reject) =>
                          setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs),
                        ),
                      ])
                    }
                    async function handleSubmit(e: SubmitEvent) {
                      e.preventDefault()

                      const form = e.currentTarget as HTMLFormElement
                      const formData = new FormData(form)
                      const code = normalizeOauthCode(String(formData.get("code") ?? ""))

                      if (!code) {
                        setFormStore("error", "Authorization code is required")
                        return
                      }

                      setFormStore("error", undefined)
                      setFormStore("submitting", true)
                      try {
                        console.log("Submitting OAuth callback:", { providerID: props.provider, method: store.methodIndex, hasCode: !!code })
                        const result = await withTimeout(
                          globalSDK.client.provider.oauth.callback({
                            providerID: props.provider,
                            method: store.methodIndex,
                            code,
                          }),
                          30000, // 30 second timeout
                        )
                        // Handle result with error property (if SDK returns { error } format)
                        if (result && typeof result === "object" && "error" in result && result.error) {
                          setFormStore("error", extractErrorMessage(result.error))
                          return
                        }
                        console.log("OAuth callback successful")
                        await complete()
                      } catch (err) {
                        console.error("OAuth callback error:", err)
                        if (err instanceof Error && err.message.includes("timed out")) {
                          setFormStore("error", "Request timed out. Please check your connection and try again.")
                        } else {
                          setFormStore("error", extractErrorMessage(err))
                        }
                      } finally {
                        setFormStore("submitting", false)
                      }
                    }

                    return (
                      <div class="flex flex-col gap-6">
                        <div class="text-14-regular text-text-base">
                          Visit <Link href={store.authorization!.url}>this link</Link> to collect your authorization
                          code to connect your account and use {provider().name} models in OpenCode.
                        </div>
                        <Show when={props.provider === "codex" && store.authorization?.url}>
                          <TextField label="Login link" value={store.authorization!.url} readOnly copyable />
                        </Show>
                        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
                          <TextField
                            autofocus
                            type="text"
                            label={`${method()?.label} authorization code`}
                            placeholder="Authorization code"
                            name="code"
                            value={formStore.value}
                            onChange={setFormStore.bind(null, "value")}
                            validationState={formStore.error ? "invalid" : undefined}
                            error={formStore.error}
                            disabled={formStore.submitting}
                          />
                          <Button class="w-auto" type="submit" size="large" variant="primary" disabled={formStore.submitting}>
                            <Show when={formStore.submitting} fallback="Submit">
                              <div class="flex items-center gap-2">
                                <Spinner />
                                <span>Connecting...</span>
                              </div>
                            </Show>
                          </Button>
                        </form>
                      </div>
                    )
                  })}
                </Match>
                <Match when={store.authorization?.method === "auto"}>
                  {iife(() => {
                    const code = createMemo(() => {
                      const instructions = store.authorization?.instructions
                      if (instructions?.includes(":")) {
                        return instructions?.split(":")[1]?.trim()
                      }
                      return instructions
                    })
                    const showCode = createMemo(() => props.provider !== "codex" && !!code())
                    const waitingLabel = createMemo(() =>
                      props.provider === "codex" ? "Waiting for ChatGPT login..." : "Waiting for authorization...",
                    )

                    onMount(async () => {
                      const result = await globalSDK.client.provider.oauth.callback({
                        providerID: props.provider,
                        method: store.methodIndex,
                      })
                      if (result.error) {
                        // TODO: show error
                        dialog.close()
                        return
                      }
                      await complete()
                    })

                    return (
                      <div class="flex flex-col gap-6">
                        <div class="text-14-regular text-text-base">
                          <Switch>
                            <Match when={props.provider === "codex"}>
                              Visit <Link href={store.authorization!.url}>this link</Link> to sign in with ChatGPT and
                              return here to finish connecting.
                            </Match>
                            <Match when={true}>
                              Visit <Link href={store.authorization!.url}>this link</Link> and enter the code below to
                              connect your account and use {provider().name} models in OpenCode.
                            </Match>
                          </Switch>
                        </div>
                        <Show when={props.provider === "codex"}>
                          <TextField label="Login link" value={store.authorization!.url} readOnly copyable />
                        </Show>
                        <Show when={showCode()}>
                          <TextField label="Confirmation code" class="font-mono" value={code()} readOnly copyable />
                        </Show>
                        <div class="text-14-regular text-text-base flex items-center gap-4">
                          <Spinner />
                          <span>{waitingLabel()}</span>
                        </div>
                      </div>
                    )
                  })}
                </Match>
              </Switch>
            </Match>
          </Switch>
        </div>
      </div>
    </Dialog>
  )
}
