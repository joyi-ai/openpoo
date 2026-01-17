import { Component, createMemo, createResource, createSignal, For, Match, Show, Switch as SolidSwitch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/tag"
import { Switch as ToggleSwitch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

interface InstalledPlugin {
  id: string
  source: "local" | "marketplace"
  path: string
  enabled: boolean
  manifest: {
    name: string
    version: string
    description?: string
    author?: { name: string; email?: string } | string
  }
  installedAt: number
}

interface MarketplaceEntry {
  id: string
  name: string
  version?: string
  description?: string
  author?: { name: string; email?: string }
  source: string | { source: string; url: string }
  tags?: string[]
  category?: string
  homepage?: string
}

interface PluginStats {
  name: string
  downloads: number
  stars: number
  version?: string
}

type PluginSection = "claude" | "opencode"
type ClaudeSubTab = "available" | "installed"

function formatDownloads(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function getPluginName(plugin: string): string {
  if (plugin.startsWith("file://")) {
    try {
      const url = new URL(plugin)
      const pathname = url.pathname
      const basename = pathname.split("/").pop() ?? ""
      return basename.replace(/\.(ts|js)$/, "")
    } catch {
      return plugin
    }
  }
  const lastAt = plugin.lastIndexOf("@")
  if (lastAt > 0) {
    return plugin.substring(0, lastAt)
  }
  return plugin
}

export const PluginsPanel: Component = () => {
  const [section, setSection] = createSignal<PluginSection>("claude")

  return (
    <div class="flex flex-col gap-3 px-2.5 pb-3">
      <div class="flex gap-2">
        <Button
          variant={section() === "claude" ? "primary" : "ghost"}
          size="small"
          onClick={() => setSection("claude")}
        >
          Claude Code
        </Button>
        <Button
          variant={section() === "opencode" ? "primary" : "ghost"}
          size="small"
          onClick={() => setSection("opencode")}
        >
          OpenCode
        </Button>
      </div>

      <SolidSwitch>
        <Match when={section() === "claude"}>
          <ClaudePluginsSection />
        </Match>
        <Match when={section() === "opencode"}>
          <OpenCodePluginsSection />
        </Match>
      </SolidSwitch>
    </div>
  )
}

const ClaudePluginsSection: Component = () => {
  const server = useServer()
  const [tab, setTab] = createSignal<ClaudeSubTab>("available")
  const [loading, setLoading] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")

  const [installed, { refetch: refetchInstalled }] = createResource(async () => {
    const response = await fetch(`${server.url}/claude-plugin/installed`)
    if (!response.ok) return []
    return (await response.json()) as InstalledPlugin[]
  })

  const [marketplace, { refetch: refetchMarketplace }] = createResource(async () => {
    const response = await fetch(`${server.url}/claude-plugin/marketplace`)
    if (!response.ok) return []
    return (await response.json()) as MarketplaceEntry[]
  })

  const [stats] = createResource(async () => {
    try {
      const response = await fetch(`${server.url}/claude-plugin/stats`)
      if (!response.ok) return {} as Record<string, PluginStats>
      const text = await response.text()
      if (!text || text.startsWith("<")) return {} as Record<string, PluginStats>
      return JSON.parse(text) as Record<string, PluginStats>
    } catch {
      return {} as Record<string, PluginStats>
    }
  })

  const getDownloads = (name: string): number => {
    const s = stats()
    if (!s) return 0
    return s[name.toLowerCase()]?.downloads ?? 0
  }

  const availablePlugins = createMemo(() => {
    const installedIds = new Set(installed()?.map((p) => p.manifest.name) ?? [])
    const s = stats() ?? {}
    return (marketplace() ?? [])
      .filter((p) => !installedIds.has(p.name))
      .sort((a, b) => {
        const aDownloads = s[a.name.toLowerCase()]?.downloads ?? 0
        const bDownloads = s[b.name.toLowerCase()]?.downloads ?? 0
        return bDownloads - aDownloads
      })
  })

  const filteredInstalled = createMemo(() => {
    const query = searchQuery().toLowerCase()
    if (!query) return installed() ?? []
    return (installed() ?? []).filter(
      (p) => p.manifest.name.toLowerCase().includes(query) || p.manifest.description?.toLowerCase().includes(query),
    )
  })

  const filteredAvailable = createMemo(() => {
    const query = searchQuery().toLowerCase()
    if (!query) return availablePlugins()
    return availablePlugins().filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.description?.toLowerCase().includes(query) ||
        p.tags?.some((t) => t.toLowerCase().includes(query)),
    )
  })

  async function installPlugin(id: string) {
    setLoading(id)
    try {
      await fetch(`${server.url}/claude-plugin/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
      await refetchInstalled()
      await refetchMarketplace()
      showToast({ variant: "success", title: "Plugin installed" })
    } catch (err) {
      showToast({ variant: "error", title: "Install failed", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(null)
    }
  }

  async function uninstallPlugin(id: string) {
    setLoading(id)
    try {
      await fetch(`${server.url}/claude-plugin/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
      await refetchInstalled()
      showToast({ variant: "success", title: "Plugin uninstalled" })
    } catch (err) {
      showToast({ variant: "error", title: "Uninstall failed", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(null)
    }
  }

  async function togglePlugin(id: string, enabled: boolean) {
    setLoading(id)
    try {
      const endpoint = enabled ? "enable" : "disable"
      await fetch(`${server.url}/claude-plugin/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
      await refetchInstalled()
      showToast({ variant: "success", title: enabled ? "Plugin enabled" : "Plugin disabled" })
    } catch (err) {
      showToast({ variant: "error", title: "Toggle failed", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(null)
    }
  }

  function getAuthorName(author: { name: string; email?: string } | string | undefined): string {
    if (!author) return ""
    if (typeof author === "string") return author
    return author.name
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <div class="flex gap-1">
          <Button variant={tab() === "available" ? "secondary" : "ghost"} size="small" onClick={() => setTab("available")}>
            Available
            <Show when={availablePlugins().length}>
              <Tag>{availablePlugins().length}</Tag>
            </Show>
          </Button>
          <Button variant={tab() === "installed" ? "secondary" : "ghost"} size="small" onClick={() => setTab("installed")}>
            Installed
            <Show when={installed()?.length}>
              <Tag>{installed()?.length}</Tag>
            </Show>
          </Button>
        </div>
        <div class="flex-1" />
        <input
          type="text"
          placeholder="Search..."
          class="px-2 py-1 w-40 rounded-md bg-surface-raised-base border border-border-base text-13-regular text-text-base placeholder:text-text-weak focus:outline-none focus:border-border-strong-base"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </div>

      <SolidSwitch>
        <Match when={tab() === "available"}>
          <Show
            when={!marketplace.loading}
            fallback={<div class="text-13-regular text-text-weak py-4 text-center">Loading...</div>}
          >
            <Show
              when={filteredAvailable().length > 0}
              fallback={
                <div class="text-13-regular text-text-weak py-4 text-center">
                  {searchQuery() ? "No plugins match your search" : "No plugins available"}
                </div>
              }
            >
              <div class="flex flex-col gap-2 max-h-80 overflow-auto">
                <For each={filteredAvailable()}>
                  {(plugin) => (
                    <div class="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-raised-base border border-border-base">
                      <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <span class="font-medium truncate">{plugin.name}</span>
                          <Show when={getDownloads(plugin.name) > 0}>
                            <span class="text-11-regular text-text-weaker flex items-center gap-0.5">
                              <Icon name="download" class="size-3" />
                              {formatDownloads(getDownloads(plugin.name))}
                            </span>
                          </Show>
                        </div>
                        <Show when={plugin.description}>
                          <span class="text-11-regular text-text-weaker truncate">{plugin.description}</span>
                        </Show>
                      </div>
                      <Button
                        variant="primary"
                        size="small"
                        disabled={loading() === plugin.id}
                        onClick={() => installPlugin(plugin.id)}
                      >
                        {loading() === plugin.id ? "..." : "Install"}
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Match>

        <Match when={tab() === "installed"}>
          <Show
            when={filteredInstalled().length > 0}
            fallback={
              <div class="text-13-regular text-text-weak py-4 text-center">
                <p>No plugins installed</p>
                <Button variant="ghost" size="small" class="mt-2" onClick={() => setTab("available")}>
                  Browse available plugins
                </Button>
              </div>
            }
          >
            <div class="flex flex-col gap-2 max-h-80 overflow-auto">
              <For each={filteredInstalled()}>
                {(plugin) => (
                  <div class="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-raised-base border border-border-base">
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="font-medium truncate">{plugin.manifest.name}</span>
                        <Tag>{plugin.manifest.version}</Tag>
                        <Tag>{plugin.source}</Tag>
                      </div>
                      <Show when={plugin.manifest.description}>
                        <span class="text-11-regular text-text-weaker truncate">{plugin.manifest.description}</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={loading() === plugin.id}
                        onClick={() => uninstallPlugin(plugin.id)}
                      >
                        Uninstall
                      </Button>
                      <ToggleSwitch
                        checked={plugin.enabled}
                        disabled={loading() === plugin.id}
                        onChange={() => togglePlugin(plugin.id, !plugin.enabled)}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Match>
      </SolidSwitch>
    </div>
  )
}

const OpenCodePluginsSection: Component = () => {
  const sdk = useSDK()
  const sync = useSync()
  const [loading, setLoading] = createSignal<string | null>(null)

  const plugins = createMemo(() => sync.data.config.plugin ?? [])
  const disabledPlugins = createMemo(() => new Set(sync.data.config.pluginDisabled ?? []))

  const items = createMemo(() =>
    plugins().map((plugin) => {
      const name = getPluginName(plugin)
      return {
        specifier: plugin,
        name,
        disabled: disabledPlugins().has(name) || disabledPlugins().has(plugin),
      }
    }),
  )

  const togglePlugin = async (specifier: string, name: string, enabled: boolean) => {
    if (loading()) return
    setLoading(name)
    try {
      const currentDisabled = sync.data.config.pluginDisabled ?? []
      let newDisabled: string[]
      if (enabled) {
        // Remove from disabled list
        newDisabled = currentDisabled.filter((d) => d !== name && d !== specifier)
      } else {
        // Add to disabled list
        newDisabled = [...currentDisabled, name]
      }
      await sdk.client.config.update({
        config: { pluginDisabled: newDisabled },
      })
      const config = await sdk.client.config.get()
      if (config.data) sync.set("config", config.data)
      showToast({
        variant: "success",
        title: enabled ? "Plugin enabled" : "Plugin disabled",
        description: "Restart OpenCode to apply changes",
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: "Failed to update plugin",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(null)
    }
  }

  const enabledCount = createMemo(() => items().filter((i) => !i.disabled).length)
  const totalCount = createMemo(() => items().length)

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div class="flex flex-col gap-0.5">
          <div class="text-12-regular text-text-weak">Plugins from opencode.json configuration</div>
          <div class="text-11-regular text-text-weaker">
            {enabledCount()} of {totalCount()} enabled
          </div>
        </div>
      </div>

      <Show
        when={items().length > 0}
        fallback={
          <div class="text-13-regular text-text-weak py-4 text-center">
            No plugins configured. Add plugins to your opencode.json file.
          </div>
        }
      >
        <div class="flex flex-col gap-2 max-h-80 overflow-auto">
          <For each={items()}>
            {(item) => (
              <div class="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-raised-base border border-border-base">
                <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span class="font-medium truncate">{item.name}</span>
                  <span class="text-11-regular text-text-weaker truncate">{item.specifier}</span>
                </div>
                <ToggleSwitch
                  checked={!item.disabled}
                  disabled={loading() === item.name}
                  onChange={() => togglePlugin(item.specifier, item.name, item.disabled)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
