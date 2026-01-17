import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  type Entry = {
    name: string
    hook: Hooks
  }

  const BUILTIN = ["opencode-anthropic-auth@0.0.9", "@gitlab/opencode-gitlab-auth@1.3.0"]

  // Built-in plugins that are directly imported (not installed from npm)
  const INTERNAL_PLUGINS: PluginInstance[] = [CodexAuthPlugin, CopilotAuthPlugin]

  const state = Instance.state(async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const entries: Entry[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }

    const resolvePlugin = async (spec: string) => {
      if (spec.startsWith("file://")) return spec
      const lastAtIndex = spec.lastIndexOf("@")
      const pkg = lastAtIndex > 0 ? spec.substring(0, lastAtIndex) : spec
      const version = lastAtIndex > 0 ? spec.substring(lastAtIndex + 1) : "latest"
      const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
      const installed = await BunProc.install(pkg, version).catch((err) => {
        if (!builtin) throw err
        const message = err instanceof Error ? err.message : String(err)
        log.error("failed to install builtin plugin", {
          pkg,
          version,
          error: message,
        })
        Bus.publish(Session.Event.Error, {
          error: new NamedError.Unknown({
            message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
          }).toObject(),
        })
        return ""
      })
      if (!installed) return undefined
      return installed
    }

    // Load internal plugins first
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      for (const plugin of INTERNAL_PLUGINS) {
        const name = plugin.name || "internal"
        log.info("loading internal plugin", { name })
        const init = await plugin(input)
        entries.push({ name, hook: init })
      }
    }

    const plugins = [...(config.plugin ?? [])]
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins.push(...BUILTIN)
    }
    for (const plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (plugin.includes("opencode-openai-codex-auth")) continue
      log.info("loading plugin", { path: plugin })
      const name = Config.getPluginName(plugin)
      const resolved = await resolvePlugin(plugin)
      if (!resolved) continue
      const mod = await import(resolved)
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
        if (seen.has(fn)) continue
        seen.add(fn)
        const init = await fn(input)
        entries.push({ name, hook: init })
      }
    }

    return {
      entries,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const entry of await state().then((x) => x.entries)) {
      const fn = entry.hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return entries().then((x) => x.map((entry) => entry.hook))
  }

  export async function entries() {
    return state().then((x) => x.entries)
  }

  export async function init() {
    const hooks = await state().then((x) => x.entries)
    const config = await Config.get()
    for (const hook of hooks) {
      await hook.hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.entries)
      for (const hook of hooks) {
        hook.hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
