import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"
import { ClaudePluginSchema } from "./schema"

export namespace ClaudePluginDiscovery {
  const log = Log.create({ service: "claude-plugin.discovery" })

  export interface DiscoveredPlugin {
    id: string
    path: string
    manifest: ClaudePluginSchema.Manifest
    hasCommands: boolean
    hasAgents: boolean
    hasSkills: boolean
    hasHooks: boolean
    hasMcp: boolean
    hasLsp: boolean
    source?: "local" | "claude-database"
  }

  // Claude installed plugins database structure
  interface ClaudePluginInstallation {
    scope?: string
    installPath: string
    version?: string
    installedAt?: string
    lastUpdated?: string
    gitCommitSha?: string
    isLocal?: boolean
  }

  interface ClaudeInstalledPluginsDatabase {
    version: 1 | 2
    plugins: Record<string, ClaudePluginInstallation | ClaudePluginInstallation[]>
  }

  interface ClaudeSettings {
    enabledPlugins?: Record<string, boolean>
    [key: string]: unknown
  }

  const PLUGIN_MANIFEST_GLOB = new Bun.Glob("*/.claude-plugin/plugin.json")

  /**
   * Discover all Claude Code plugins from .claude directories
   */
  export async function discoverLocal(): Promise<DiscoveredPlugin[]> {
    const plugins: DiscoveredPlugin[] = []
    const seen = new Set<string>()

    // Scan project-level .claude directories
    const claudeDirs = await Array.fromAsync(
      Filesystem.up({
        targets: [".claude"],
        start: Instance.directory,
        stop: Instance.worktree,
      }),
    )

    // Also include global ~/.claude directory
    const globalClaude = path.join(Global.Path.home, ".claude")
    if (await Filesystem.exists(globalClaude)) {
      claudeDirs.push(globalClaude)
    }

    for (const claudeDir of claudeDirs) {
      // Look for plugins in subdirectories with .claude-plugin/plugin.json
      for await (const match of PLUGIN_MANIFEST_GLOB.scan({
        cwd: claudeDir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
        dot: true,
      })) {
        const pluginDir = path.dirname(path.dirname(match))
        const plugin = await parsePlugin(pluginDir)
        if (plugin && !seen.has(plugin.id)) {
          seen.add(plugin.id)
          plugins.push(plugin)
        }
      }

      // Also check if the .claude directory itself is a plugin
      const directManifest = path.join(claudeDir, ".claude-plugin", "plugin.json")
      if (await Filesystem.exists(directManifest)) {
        const plugin = await parsePlugin(claudeDir)
        if (plugin && !seen.has(plugin.id)) {
          seen.add(plugin.id)
          plugins.push(plugin)
        }
      }
    }

    log.info("discovered plugins", { count: plugins.length })
    return plugins
  }

  /**
   * Parse a plugin from a directory
   */
  export async function parsePlugin(dir: string): Promise<DiscoveredPlugin | undefined> {
    const manifestPath = path.join(dir, ".claude-plugin", "plugin.json")

    const manifestText = await Bun.file(manifestPath)
      .text()
      .catch(() => undefined)
    if (!manifestText) {
      log.warn("could not read plugin manifest", { path: manifestPath })
      return undefined
    }

    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(manifestText)
    } catch {
      log.warn("invalid plugin manifest json", { path: manifestPath })
      return undefined
    }

    const parsed = ClaudePluginSchema.Manifest.safeParse(manifestJson)
    if (!parsed.success) {
      log.warn("invalid plugin manifest", { path: manifestPath, issues: parsed.error.issues })
      return undefined
    }

    const manifest = parsed.data
    const id = `${manifest.name}@${manifest.version}`

    // Check which components exist
    const [hasCommands, hasAgents, hasSkills, hasHooks, hasMcp, hasLsp] = await Promise.all([
      Filesystem.exists(path.join(dir, "commands")),
      Filesystem.exists(path.join(dir, "agents")),
      Filesystem.exists(path.join(dir, "skills")),
      Filesystem.exists(path.join(dir, "hooks", "hooks.json")),
      Filesystem.exists(path.join(dir, ".mcp.json")),
      Filesystem.exists(path.join(dir, ".lsp.json")),
    ])

    log.info("parsed plugin", {
      id,
      path: dir,
      hasCommands,
      hasAgents,
      hasSkills,
      hasHooks,
      hasMcp,
      hasLsp,
    })

    return {
      id,
      path: dir,
      manifest,
      hasCommands,
      hasAgents,
      hasSkills,
      hasHooks,
      hasMcp,
      hasLsp,
    }
  }

  /**
   * Discover plugins from Claude's installed_plugins.json database
   */
  export async function discoverClaudeDatabase(): Promise<DiscoveredPlugin[]> {
    const plugins: DiscoveredPlugin[] = []
    const seen = new Set<string>()

    // Read Claude's installed plugins database
    const dbPath = path.join(Global.Path.home, ".claude", "plugins", "installed_plugins.json")
    const dbText = await Bun.file(dbPath)
      .text()
      .catch(() => undefined)

    if (!dbText) {
      log.info("no claude plugins database found", { path: dbPath })
      return plugins
    }

    let db: ClaudeInstalledPluginsDatabase
    try {
      db = JSON.parse(dbText)
    } catch {
      log.warn("invalid claude plugins database json", { path: dbPath })
      return plugins
    }

    if (!db.plugins) {
      return plugins
    }

    // Read enabled plugins from settings.json
    const settingsPath = path.join(Global.Path.home, ".claude", "settings.json")
    const settingsText = await Bun.file(settingsPath)
      .text()
      .catch(() => undefined)

    let settings: ClaudeSettings = {}
    if (settingsText) {
      try {
        settings = JSON.parse(settingsText)
      } catch {
        log.warn("invalid claude settings json", { path: settingsPath })
      }
    }

    const enabledPlugins = settings.enabledPlugins ?? {}

    // Extract plugin entries (handle both v1 and v2 database formats)
    for (const [pluginKey, installation] of Object.entries(db.plugins)) {
      const installations = Array.isArray(installation) ? installation : [installation]

      for (const inst of installations) {
        if (!inst.installPath) continue

        // Check if enabled (default true if not in settings)
        const isEnabled = !(pluginKey in enabledPlugins) || enabledPlugins[pluginKey]
        if (!isEnabled) {
          log.info("plugin disabled", { pluginKey })
          continue
        }

        // Check if path exists
        if (!(await Filesystem.exists(inst.installPath))) {
          log.warn("plugin path does not exist", { pluginKey, path: inst.installPath })
          continue
        }

        const plugin = await parsePlugin(inst.installPath)
        if (plugin && !seen.has(plugin.id)) {
          seen.add(plugin.id)
          plugins.push({ ...plugin, source: "claude-database" })
        }
      }
    }

    log.info("discovered claude database plugins", { count: plugins.length })
    return plugins
  }

  /**
   * Discover all plugins from both local .claude directories and Claude's database
   * Claude database plugins take precedence over local plugins
   */
  export async function discoverAll(): Promise<DiscoveredPlugin[]> {
    const [local, claudeDb] = await Promise.all([discoverLocal(), discoverClaudeDatabase()])

    // Merge, preferring Claude database plugins over local
    const seen = new Set<string>()
    const result: DiscoveredPlugin[] = []

    // Add Claude database plugins first (they take precedence)
    for (const plugin of claudeDb) {
      seen.add(plugin.id)
      result.push(plugin)
    }

    // Add local plugins that aren't in Claude database
    for (const plugin of local) {
      if (!seen.has(plugin.id)) {
        result.push({ ...plugin, source: "local" })
      }
    }

    log.info("discovered all plugins", {
      total: result.length,
      fromClaudeDb: claudeDb.length,
      fromLocal: local.length,
    })

    return result
  }
}
