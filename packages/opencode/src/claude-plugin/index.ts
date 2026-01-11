import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { ClaudePluginConfig } from "./config"
import { ClaudePluginDiscovery } from "./discovery"
import { ClaudePluginHooks } from "./hooks"
import { ClaudePluginLoader } from "./loader"
import { ClaudePluginMarketplace } from "./marketplace"
import { ClaudePluginSchema } from "./schema"
import { ClaudePluginStats } from "./stats"
import { ClaudePluginStorage } from "./storage"
import { ClaudePluginTransform } from "./transform"
import { ClaudePluginTranscript } from "./transcript"

export namespace ClaudePlugin {
  const log = Log.create({ service: "claude-plugin" })

  // Re-export submodules
  export const Schema = ClaudePluginSchema
  export const Config = ClaudePluginConfig
  export const Discovery = ClaudePluginDiscovery
  export const Storage = ClaudePluginStorage
  export const Loader = ClaudePluginLoader
  export const Marketplace = ClaudePluginMarketplace
  export const Stats = ClaudePluginStats
  export const Hooks = ClaudePluginHooks
  export const Transform = ClaudePluginTransform
  export const Transcript = ClaudePluginTranscript

  // Bus events
  export const Event = {
    Loaded: BusEvent.define(
      "claude-plugin.loaded",
      z.object({
        pluginId: z.string(),
        pluginName: z.string(),
      }),
    ),
    Unloaded: BusEvent.define(
      "claude-plugin.unloaded",
      z.object({
        pluginId: z.string(),
      }),
    ),
    Enabled: BusEvent.define(
      "claude-plugin.enabled",
      z.object({
        pluginId: z.string(),
      }),
    ),
    Disabled: BusEvent.define(
      "claude-plugin.disabled",
      z.object({
        pluginId: z.string(),
      }),
    ),
  }

  // Instance-scoped state
  const state = Instance.state(
    async () => {
      const plugins = new Map<string, ClaudePluginLoader.LoadedPlugin>()

      // Discover all plugins (local + Claude database, with Claude database taking precedence)
      const discovered = await ClaudePluginDiscovery.discoverAll()

      // Load enabled plugins
      for (const disc of discovered) {
        const stored = await ClaudePluginStorage.get(disc.id)
        const enabled = stored?.enabled ?? true // Enable by default for newly discovered plugins

        if (enabled) {
          const loaded = await ClaudePluginLoader.loadPlugin(disc.path)
          if (loaded) {
            plugins.set(loaded.id, loaded)
            ClaudePluginHooks.register(loaded.hooks)
            // Register plugin path for variable resolution in hooks
            ClaudePluginHooks.registerPluginPath(loaded.id, loaded.path)
          }
        }

        // Save to storage if new (claude-database source maps to "local" for storage purposes)
        if (!stored) {
          await ClaudePluginStorage.save({
            id: disc.id,
            source: "local",
            path: disc.path,
            enabled,
            manifest: disc.manifest,
            installedAt: Date.now(),
          })
        }
      }

      // Initialize hook subscriptions
      await ClaudePluginHooks.init()

      log.info("loaded plugins", { count: plugins.size })
      return { plugins }
    },
    async () => {
      ClaudePluginHooks.clear()
    },
  )

  /**
   * List all loaded plugins
   */
  export async function list(): Promise<ClaudePluginLoader.LoadedPlugin[]> {
    const s = await state()
    return Array.from(s.plugins.values())
  }

  /**
   * Get a specific loaded plugin
   */
  export async function get(id: string): Promise<ClaudePluginLoader.LoadedPlugin | undefined> {
    const s = await state()
    return s.plugins.get(id)
  }

  /**
   * Install a plugin from the marketplace
   */
  export async function install(id: string): Promise<ClaudePluginLoader.LoadedPlugin> {
    const entry = await ClaudePluginMarketplace.get(id)
    if (!entry) {
      throw new Error(`Plugin not found in marketplace: ${id}`)
    }

    // Download the plugin
    const pluginPath = await ClaudePluginMarketplace.download(entry)

    // Load the plugin
    const loaded = await ClaudePluginLoader.loadPlugin(pluginPath)
    if (!loaded) {
      throw new Error(`Failed to load plugin: ${id}`)
    }

    // Save to storage
    await ClaudePluginStorage.save({
      id: loaded.id,
      source: "marketplace",
      path: pluginPath,
      enabled: true,
      manifest: loaded.manifest,
      installedAt: Date.now(),
    })

    // Add to state
    const s = await state()
    s.plugins.set(loaded.id, loaded)
    ClaudePluginHooks.register(loaded.hooks)
    ClaudePluginHooks.registerPluginPath(loaded.id, loaded.path)

    Bus.publish(Event.Loaded, { pluginId: loaded.id, pluginName: loaded.name })
    log.info("installed plugin", { id: loaded.id })

    return loaded
  }

  /**
   * Uninstall a plugin
   */
  export async function uninstall(id: string): Promise<void> {
    const s = await state()
    const plugin = s.plugins.get(id)

    // Remove from state
    s.plugins.delete(id)

    // Remove from storage
    await ClaudePluginStorage.remove(id)

    // Rebuild hook registry
    ClaudePluginHooks.clear()
    for (const p of s.plugins.values()) {
      ClaudePluginHooks.register(p.hooks)
    }

    Bus.publish(Event.Unloaded, { pluginId: id })
    log.info("uninstalled plugin", { id })
  }

  /**
   * Enable a plugin
   */
  export async function enable(id: string): Promise<void> {
    const stored = await ClaudePluginStorage.get(id)
    if (!stored) {
      throw new Error(`Plugin not found: ${id}`)
    }

    await ClaudePluginStorage.setEnabled(id, true)

    // Load the plugin if not already loaded
    const s = await state()
    if (!s.plugins.has(id)) {
      const loaded = await ClaudePluginLoader.loadPlugin(stored.path)
      if (loaded) {
        s.plugins.set(loaded.id, loaded)
        ClaudePluginHooks.register(loaded.hooks)
        ClaudePluginHooks.registerPluginPath(loaded.id, loaded.path)
      }
    }

    Bus.publish(Event.Enabled, { pluginId: id })
    log.info("enabled plugin", { id })
  }

  /**
   * Disable a plugin
   */
  export async function disable(id: string): Promise<void> {
    await ClaudePluginStorage.setEnabled(id, false)

    // Remove from state
    const s = await state()
    s.plugins.delete(id)

    // Rebuild hook registry
    ClaudePluginHooks.clear()
    for (const p of s.plugins.values()) {
      ClaudePluginHooks.register(p.hooks)
    }

    Bus.publish(Event.Disabled, { pluginId: id })
    log.info("disabled plugin", { id })
  }

  /**
   * Get all commands from loaded plugins
   */
  export async function commands(): Promise<ClaudePluginLoader.LoadedCommand[]> {
    const plugins = await list()
    return plugins.flatMap((p) => p.commands)
  }

  /**
   * Get all agents from loaded plugins
   */
  export async function agents(): Promise<ClaudePluginLoader.LoadedAgent[]> {
    const plugins = await list()
    return plugins.flatMap((p) => p.agents)
  }

  /**
   * Get all skills from loaded plugins
   */
  export async function skills(): Promise<ClaudePluginLoader.LoadedSkill[]> {
    const plugins = await list()
    return plugins.flatMap((p) => p.skills)
  }

  /**
   * Get all MCP configs from loaded plugins
   */
  export async function mcpConfigs(): Promise<ClaudePluginLoader.LoadedMcp[]> {
    const plugins = await list()
    return plugins.flatMap((p) => p.mcp)
  }

  /**
   * Get all LSP configs from loaded plugins
   */
  export async function lspConfigs(): Promise<ClaudePluginLoader.LoadedLsp[]> {
    const plugins = await list()
    return plugins.flatMap((p) => p.lsp)
  }

  export async function findCommand(name: string): Promise<ClaudePluginLoader.LoadedCommand | undefined> {
    const plugins = await list()
    for (const plugin of plugins) {
      const command = plugin.commands.find((cmd) => cmd.fullName === name)
      if (command) return command
    }
    return undefined
  }

  export async function findAgent(name: string): Promise<ClaudePluginLoader.LoadedAgent | undefined> {
    const plugins = await list()
    for (const plugin of plugins) {
      const agent = plugin.agents.find((item) => item.fullName === name)
      if (agent) return agent
    }
    return undefined
  }

  export async function findSkill(name: string): Promise<ClaudePluginLoader.LoadedSkill | undefined> {
    const plugins = await list()
    for (const plugin of plugins) {
      const skill = plugin.skills.find((item) => item.name === name)
      if (skill) return skill
    }
    return undefined
  }

  export async function isCommand(name: string): Promise<boolean> {
    const command = await findCommand(name)
    return !!command
  }

  export async function isAgent(name: string): Promise<boolean> {
    const agent = await findAgent(name)
    return !!agent
  }

  export async function isSkill(name: string): Promise<boolean> {
    const skill = await findSkill(name)
    return !!skill
  }

  /**
   * Trigger hooks for an event
   */
  export async function triggerHooks(
    event: ClaudePluginSchema.HookEvent,
    context: ClaudePluginHooks.HookContext,
  ): Promise<ClaudePluginHooks.HookResult[]> {
    return ClaudePluginHooks.trigger(event, context)
  }

  /**
   * Initialize the plugin system (call early in bootstrap)
   */
  export async function init(): Promise<void> {
    await state()
  }
}
