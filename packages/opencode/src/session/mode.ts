import z from "zod"
import { Instance } from "@/project/instance"

export namespace SessionMode {
  export type ModeId = "claude-code" | "codex" | "opencode" | (string & {})

  export const Info = z.object({
    id: z.string(),
  })
  export type Info = z.infer<typeof Info>

  type AgentRules = {
    allowed?: string[]
    disabled?: string[]
  }

  const MODE_AGENT_RULES: Record<string, AgentRules> = {
    "claude-code": {
      allowed: ["build", "plan"],
    },
    codex: {
      allowed: ["build", "plan"],
    },
  }

  const state = Instance.state(() => new Map<string, Info>())

  export function normalize(mode?: Info): Info | undefined {
    if (!mode) return undefined
    return mode
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

  function getAgentRules(mode?: Info) {
    const base = mode ? MODE_AGENT_RULES[mode.id] : undefined
    const allowed = base?.allowed ? new Set(base.allowed) : undefined
    const disabled = new Set(base?.disabled ?? [])
    return { allowed, disabled }
  }

  export function isAgentAllowed(mode: Info | undefined, name: string): boolean {
    const rules = getAgentRules(mode)
    if (rules.allowed && !rules.allowed.has(name)) return false
    if (rules.disabled.has(name)) return false
    return true
  }

  export function filterAgents<T extends { name: string }>(mode: Info | undefined, agents: T[]): T[] {
    const rules = getAgentRules(mode)
    return agents.filter((agent) => {
      if (rules.allowed && !rules.allowed.has(agent.name)) return false
      if (rules.disabled.has(agent.name)) return false
      return true
    })
  }

  export function isSame(a?: Info, b?: Info): boolean {
    if (!a && !b) return true
    if (!a || !b) return false
    return a.id === b.id
  }
}
