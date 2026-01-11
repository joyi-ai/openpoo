import z from "zod"
import { Instance } from "@/project/instance"

export namespace SessionMode {
  export type ModeId = "claude-code" | "codex" | "opencode" | "oh-my-opencode" | (string & {})

  export const OhMyOpenCodeSettings = z.object({
    sisyphusAgent: z
      .object({
        disabled: z.boolean().optional(),
        defaultBuilderEnabled: z.boolean().optional(),
        plannerEnabled: z.boolean().optional(),
        replacePlan: z.boolean().optional(),
      })
      .optional(),
    disabledAgents: z.array(z.string()).optional(),
    disabledHooks: z.array(z.string()).optional(),
    claudeCode: z
      .object({
        mcp: z.boolean().optional(),
        commands: z.boolean().optional(),
        skills: z.boolean().optional(),
        agents: z.boolean().optional(),
        hooks: z.boolean().optional(),
        plugins: z.boolean().optional(),
      })
      .optional(),
    autoUpdate: z.boolean().optional(),
  })
  export type OhMyOpenCodeSettings = z.infer<typeof OhMyOpenCodeSettings>

  export const ModeSettings = z.object({
    ohMyOpenCode: OhMyOpenCodeSettings.optional(),
  })
  export type ModeSettings = z.infer<typeof ModeSettings>

  export const Info = z.object({
    id: z.string(),
    settings: ModeSettings.optional(),
  })
  export type Info = z.infer<typeof Info>

  export type ClaudeFeature = "mcp" | "commands" | "skills" | "agents" | "hooks" | "plugins"

  const DEFAULT_OH_MY_SETTINGS: OhMyOpenCodeSettings = {
    sisyphusAgent: {
      disabled: false,
      defaultBuilderEnabled: false,
      plannerEnabled: true,
      replacePlan: true,
    },
    disabledAgents: [],
    disabledHooks: [],
    claudeCode: {
      mcp: true,
      commands: true,
      skills: true,
      agents: true,
      hooks: true,
      plugins: true,
    },
    autoUpdate: true,
  }

  const OH_MY_AGENT_NAMES = new Set([
    "Sisyphus",
    "OpenCode-Builder",
    "Planner-Sisyphus",
    "oracle",
    "librarian",
    "explore",
    "frontend-ui-ux-engineer",
    "document-writer",
    "multimodal-looker",
  ])

  const state = Instance.state(() => new Map<string, Info>())

  function mergeOhMySettings(input?: OhMyOpenCodeSettings): OhMyOpenCodeSettings {
    const defaults = DEFAULT_OH_MY_SETTINGS
    return {
      sisyphusAgent: {
        ...defaults.sisyphusAgent,
        ...input?.sisyphusAgent,
      },
      disabledAgents: [...(input?.disabledAgents ?? defaults.disabledAgents ?? [])],
      disabledHooks: [...(input?.disabledHooks ?? defaults.disabledHooks ?? [])],
      claudeCode: {
        ...defaults.claudeCode,
        ...input?.claudeCode,
      },
      autoUpdate: input?.autoUpdate ?? defaults.autoUpdate,
    }
  }

  export function normalize(mode?: Info): Info | undefined {
    if (!mode) return undefined
    if (mode.id !== "oh-my-opencode") return mode
    const settings = mergeOhMySettings(mode.settings?.ohMyOpenCode)
    return {
      ...mode,
      settings: {
        ...mode.settings,
        ohMyOpenCode: settings,
      },
    }
  }

  export function set(sessionID: string, mode?: Info): void {
    const next = normalize(mode)
    if (!next) {
      state().delete(sessionID)
      return
    }
    state().set(sessionID, next)
  }

  export function get(sessionID: string): Info | undefined {
    return state().get(sessionID)
  }

  export function clear(sessionID: string): void {
    state().delete(sessionID)
  }

  export function isOhMyMode(mode?: Info): boolean {
    return mode?.id === "oh-my-opencode"
  }

  export function ohMySettings(mode?: Info): OhMyOpenCodeSettings | undefined {
    if (!isOhMyMode(mode)) return undefined
    return mergeOhMySettings(mode?.settings?.ohMyOpenCode)
  }

  export function isClaudeFeatureEnabled(mode: Info | undefined, feature: ClaudeFeature): boolean {
    if (!isOhMyMode(mode)) return true
    const settings = ohMySettings(mode)
    const flags = settings?.claudeCode
    if (!flags) return true
    if (flags.plugins === false) return false
    return flags[feature] ?? true
  }

  export function isOhMyPlugin(name: string): boolean {
    if (name === "oh-my-opencode") return true
    return name.startsWith("oh-my-opencode@")
  }

  export function isHookDisabled(mode: Info | undefined, hook?: string): boolean {
    if (!isOhMyMode(mode)) return false
    if (!hook) return false
    const settings = ohMySettings(mode)
    const disabled = settings?.disabledHooks ?? []
    if (disabled.length === 0) return false
    return disabled.some((name) => hook.includes(name))
  }

  export function isOhMyAgent(name: string): boolean {
    return OH_MY_AGENT_NAMES.has(name)
  }

  export function isAgentAllowed(mode: Info | undefined, name: string): boolean {
    if (!isOhMyMode(mode)) {
      if (isOhMyAgent(name)) return false
      return true
    }

    const settings = ohMySettings(mode)
    if (!settings) return true

    const disabled = new Set(settings.disabledAgents ?? [])
    const sisyphusDisabled = settings.sisyphusAgent?.disabled === true
    const replacePlan = settings.sisyphusAgent?.replacePlan ?? true

    if (!sisyphusDisabled) {
      disabled.add("build")
      if (replacePlan) disabled.add("plan")
    }

    if (settings.sisyphusAgent?.disabled) disabled.add("Sisyphus")
    if (settings.sisyphusAgent?.defaultBuilderEnabled === false) disabled.add("OpenCode-Builder")
    if (settings.sisyphusAgent?.plannerEnabled === false) disabled.add("Planner-Sisyphus")

    if (disabled.has(name)) return false
    return true
  }

  export function isSame(a?: Info, b?: Info): boolean {
    if (!a && !b) return true
    if (!a || !b) return false
    if (a.id !== b.id) return false
    const aSettings = a.settings ?? {}
    const bSettings = b.settings ?? {}
    return JSON.stringify(aSettings) === JSON.stringify(bSettings)
  }
}
