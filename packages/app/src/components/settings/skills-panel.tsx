import { Show, createMemo, createSignal, type Component } from "solid-js"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useSync, type SkillInfo } from "@/context/sync"
import type { PermissionActionConfig, PermissionObjectConfig, PermissionRuleConfig, PermissionConfig } from "@opencode-ai/sdk/v2/client"

type PermissionRule = PermissionRuleConfig

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  const regex = new RegExp(`^${escaped}$`)
  return regex.test(value)
}

function normalizeRule(rule: PermissionRule | undefined): PermissionObjectConfig {
  if (!rule) return {}
  if (typeof rule === "string") return { "*": rule }
  return { ...rule }
}

function inferSource(location: string): string {
  const normalized = location.replace(/\\\\/g, "/")
  if (normalized.includes("/.claude/skills/")) return "claude"
  if (
    normalized.includes("/.opencode/skill/") ||
    normalized.includes("/.opencode/skills/") ||
    normalized.includes("/.config/opencode/skill/") ||
    normalized.includes("/.config/opencode/skills/")
  )
    return "opencode"
  if (normalized.includes("/.claude-plugin/")) return "claude-plugin"
  return "custom"
}

export const SkillsPanel: Component = () => {
  const sdk = useSDK()
  const sync = useSync()
  const [saving, setSaving] = createSignal<string | null>(null)

  // Read pre-fetched skills from sync data (fetched during app bootstrap)
  const skills = () => sync.data.skill

  const permission = createMemo<Record<string, PermissionRule>>(() => {
    const current = sync.data.config.permission
    if (!current) return {}
    if (typeof current === "string") return { "*": current }
    return current as Record<string, PermissionRule>
  })

  const skillRule = createMemo(() => normalizeRule(permission().skill))

  const resolveAction = (rules: PermissionObjectConfig, name: string) => {
    let action: PermissionActionConfig | undefined
    for (const [pattern, value] of Object.entries(rules)) {
      if (wildcardMatch(pattern, name)) action = value
    }
    return action
  }

  const skillAction = (name: string) => resolveAction(skillRule(), name)

  const isEnabled = (name: string) => skillAction(name) !== "deny"

  const updatePermission = async (nextRule: PermissionObjectConfig) => {
    const nextPermission = { ...permission(), skill: nextRule } as PermissionConfig
    const error = await sdk.client.config
      .update({ config: { permission: nextPermission } })
      .then(() => undefined)
      .catch((err) => err as Error)
    if (error) {
      showToast({
        variant: "error",
        title: "Failed to update skills",
        description: error.message,
      })
      return false
    }
    sync.set("config", "permission", nextPermission)
    return true
  }

  const toggleSkill = async (name: string, nextEnabled: boolean) => {
    if (saving()) return
    setSaving(name)
    const nextRule = normalizeRule(permission().skill)
    if (nextEnabled) {
      delete nextRule[name]
      if (resolveAction(nextRule, name) === "deny") {
        nextRule[name] = "allow"
      }
    } else {
      nextRule[name] = "deny"
    }
    const success = await updatePermission(nextRule)
    if (success) {
      showToast({
        variant: "success",
        title: nextEnabled ? "Skill enabled" : "Skill disabled",
        description: name,
      })
    }
    setSaving(null)
  }

  const items = createMemo(() => {
    const rules = skillRule()
    return (skills() ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({
        ...skill,
        enabled: resolveAction(rules, skill.name) !== "deny",
        source: inferSource(skill.location),
      }))
  })

  return (
    <div class="flex flex-col gap-2">
      <List
        search={{ placeholder: "Search skills", autofocus: false }}
        emptyMessage="No skills found"
        key={(x) => x?.name ?? ""}
        items={items()}
        filterKeys={["name", "description", "source"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (x) toggleSkill(x.name, !x.enabled)
        }}
      >
        {(skill) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="truncate text-13-regular text-text-strong">{skill.name}</span>
              <Show when={skill.description}>
                <span class="text-12-regular text-text-weak truncate">{skill.description}</span>
              </Show>
            </div>
            <Switch checked={skill.enabled} disabled={saving() === skill.name} onChange={() => toggleSkill(skill.name, !skill.enabled)} />
          </div>
        )}
      </List>
    </div>
  )
}
