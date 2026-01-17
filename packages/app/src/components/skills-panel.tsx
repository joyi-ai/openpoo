import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

interface SkillInfoWithSource {
  name: string
  description: string
  location: string
  source: "opencode" | "claude" | "claude-plugin"
}

const sourceLabels: Record<SkillInfoWithSource["source"], string> = {
  opencode: "OpenCode",
  claude: "Claude Code",
  "claude-plugin": "Plugin",
}

export const SkillsPanel: Component = () => {
  const sdk = useSDK()
  const sync = useSync()
  const [loading, setLoading] = createSignal<string | null>(null)

  const [skills, { refetch }] = createResource(async () => {
    const result = await sdk.client.skill.list()
    return (result.data ?? []) as SkillInfoWithSource[]
  })

  const permissions = createMemo(() => sync.data.config.permission ?? {})

  const isSkillDisabled = (name: string) => {
    const perm = permissions() as Record<string, string>
    const skillPerm = perm[`skill.${name}`]
    return skillPerm === "deny"
  }

  const toggleSkill = async (name: string, enabled: boolean) => {
    if (loading()) return
    setLoading(name)
    try {
      await sdk.client.config.update({
        config: {
          permission: {
            [`skill.${name}`]: enabled ? "allow" : "deny",
          },
        },
      })
      // Refetch config to update sync state
      const config = await sdk.client.config.get()
      if (config.data) sync.set("config", config.data)
      showToast({
        variant: "success",
        title: enabled ? "Skill enabled" : "Skill disabled",
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: "Failed to update skill",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(null)
    }
  }

  const items = createMemo(() => {
    const list = skills() ?? []
    return list.slice().sort((a, b) => a.name.localeCompare(b.name))
  })

  const enabledCount = createMemo(() => items().filter((i) => !isSkillDisabled(i.name)).length)
  const totalCount = createMemo(() => items().length)

  return (
    <div class="flex flex-col gap-2 px-2.5 pb-3">
      <div class="flex items-center justify-between">
        <div class="flex flex-col gap-0.5">
          <div class="text-12-regular text-text-weak">Available skills from OpenCode, Claude Code, and plugins</div>
          <div class="text-11-regular text-text-weaker">
            {enabledCount()} of {totalCount()} enabled
          </div>
        </div>
      </div>
      <List
        search={{ placeholder: "Search skills", autofocus: true }}
        emptyMessage={skills.loading ? "Loading skills..." : "No skills found"}
        key={(x) => x?.name ?? ""}
        items={items()}
        filterKeys={["name", "description", "source"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (x) toggleSkill(x.name, isSkillDisabled(x.name))
        }}
      >
        {(item) => {
          const disabled = createMemo(() => isSkillDisabled(item.name))
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate font-medium">{item.name}</span>
                  <Tag>{sourceLabels[item.source]}</Tag>
                </div>
                <Show when={item.description}>
                  <span class="text-11-regular text-text-weaker truncate">{item.description}</span>
                </Show>
              </div>
              <div class="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={!disabled()}
                  disabled={loading() === item.name}
                  onChange={() => toggleSkill(item.name, disabled())}
                />
              </div>
            </div>
          )
        }}
      </List>
    </div>
  )
}
