import { Component, createMemo, createSignal, Show } from "solid-js"
import { SyncProvider, useSync } from "@/context/sync"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { DialogEditMcp, isMcpConfigured, type McpConfigured } from "./dialog-edit-mcp"
import { useLanguage } from "@/context/language"

export const McpSettingsPanel: Component = () => {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [loading, setLoading] = createSignal<string | null>(null)

  type McpEntry = NonNullable<Config["mcp"]>[string]
  const configs = createMemo(() => sync.data.config.mcp ?? {})
  const items = createMemo(() =>
    Object.entries(configs())
      .filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1] as McpEntry))
      .map(([name, entry]) => {
        const state = sync.data.mcp?.[name]
        return {
          name,
          entry,
          status: state?.status ?? "unknown",
          state,
          type: entry.type,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggle = async (name: string) => {
    if (loading()) return
    setLoading(name)
    const status = sync.data.mcp[name]
    const error =
      status?.status === "connected"
        ? await sdk.client.mcp
            .disconnect({ name })
            .then(() => undefined)
            .catch((err) => err as Error)
        : await sdk.client.mcp
            .connect({ name })
            .then(() => undefined)
            .catch((err) => err as Error)
    if (error) {
      showToast({
        variant: "error",
        title: "MCP update failed",
        description: error.message,
      })
      setLoading(null)
      return
    }
    const result = await sdk.client.mcp.status().catch(() => undefined)
    if (result?.data) sync.set("mcp", result.data)
    setLoading(null)
  }

  const authenticate = async (name: string) => {
    if (loading()) return
    setLoading(name)
    const error = await sdk.client.mcp.auth
      .authenticate({ name })
      .then(() => undefined)
      .catch((err) => err as Error)
    if (error) {
      showToast({
        variant: "error",
        title: "Authentication failed",
        description: error.message,
      })
      setLoading(null)
      return
    }
    const result = await sdk.client.mcp.status().catch(() => undefined)
    if (result?.data) sync.set("mcp", result.data)
    setLoading(null)
  }

  const showEdit = (name?: string, entry?: McpConfigured) => {
    dialog.show(() => (
      <SDKProvider directory={sdk.directory}>
        <SyncProvider>
          <DialogEditMcp name={name} entry={entry} />
        </SyncProvider>
      </SDKProvider>
    ))
  }

  return (
    <div class="flex flex-col gap-2">
      <div class="flex justify-end px-2.5 pb-2">
        <Button size="small" icon="plus" onClick={() => showEdit()}>
          Add
        </Button>
      </div>
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.mcp.empty")}
        key={(x) => x?.name ?? ""}
        items={items()}
        filterKeys={["name", "type"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (x) toggle(x.name)
        }}
      >
        {(i) => {
          const mcpStatus = () => i.state
          const status = () => mcpStatus()?.status
          const enabled = () => status() === "connected"
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="truncate text-13-regular text-text-strong">{i.name}</span>
                <span class="text-11-regular text-text-weaker">{i.entry.type}</span>
              </div>
              <div class="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Show when={status() === "needs_auth"}>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => authenticate(i.name)}
                    disabled={loading() === i.name}
                  >
                    Auth
                  </Button>
                </Show>
                <IconButton icon="edit-small-2" variant="ghost" onClick={() => showEdit(i.name, i.entry)} />
                <Switch checked={enabled()} disabled={loading() === i.name} onChange={() => toggle(i.name)} />
              </div>
            </div>
          )
        }}
      </List>
    </div>
  )
}

export const DialogSelectMcp: Component = () => {
  const sync = useSync()
  const language = useLanguage()
  const enabledCount = createMemo(
    () => Object.values(sync.data.mcp ?? {}).filter((entry) => entry.status === "connected").length,
  )
  const totalCount = createMemo(() => Object.values(sync.data.mcp ?? {}).length)
  return (
    <Dialog
      title={language.t("dialog.mcp.title")}
      description={language.t("dialog.mcp.description", { enabled: enabledCount(), total: totalCount() })}
    >
      <McpSettingsPanel />
    </Dialog>
  )
}
