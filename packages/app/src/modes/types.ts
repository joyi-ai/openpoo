export type ModeId = "claude-code" | "codex" | "opencode" | (string & {})

export type ModeProviderOverride = string | undefined

export type ModeDefinition = {
  id: ModeId
  name: string
  description?: string
  icon?: string
  color?: string
  providerOverride?: ModeProviderOverride
  defaultAgent?: string
  allowedAgents?: string[]
  disabledAgents?: string[]
  requiresPlugins?: string[]
  overrides?: Record<string, unknown>
  builtin?: boolean
}

export type ModeOverride = {
  name?: string
  description?: string
  color?: string
  providerOverride?: ModeProviderOverride | null
  defaultAgent?: string | null
  overrides?: Record<string, unknown>
}
