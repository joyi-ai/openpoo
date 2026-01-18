export type CodexSlashAction =
  | { kind: "command"; id: string }
  | { kind: "summarize" }
  | { kind: "insert"; text: string; popover?: "at" | "slash" }
  | { kind: "settings" }
  | { kind: "link"; url: string }

// Nested option for hierarchical menus in the slash popup tray
export type NestedOption = {
  id: string
  label: string
  description?: string
  // If present, selecting shows another nested view
  nested?: NestedOptionView
  // If present, this is a terminal option that produces text to submit
  result?: string
}

// View types for nested menus
export type NestedOptionView =
  | { type: "static"; title: string; options: NestedOption[] }
  | { type: "dynamic"; title: string; loaderId: "branches" | "commits"; searchable?: boolean }
  | { type: "input"; title: string; placeholder: string }

// State for nested option stack
export type NestedStackItem = {
  view: NestedOptionView
  trigger: string
  options: NestedOption[]
  filter: string
  activeIndex: number
  loading: boolean
}

type CodexSlashCommand = {
  trigger: string
  title: string
  description: string
  action?: CodexSlashAction
  nested?: NestedOptionView
  debugOnly?: boolean
}

const CODEX_SLASH_COMMANDS: CodexSlashCommand[] = [
  {
    trigger: "approvals",
    title: "Approvals",
    description: "choose what Codex can do without approval",
    action: { kind: "settings" },
  },
  {
    trigger: "review",
    title: "Review",
    description: "review my current changes and find issues",
    nested: {
      type: "static",
      title: "Select a review preset",
      options: [
        {
          id: "review-branch",
          label: "Review against a base branch",
          description: "Compare current branch to another branch",
          nested: {
            type: "dynamic",
            title: "Select a branch",
            loaderId: "branches",
            searchable: true,
          },
        },
        {
          id: "review-uncommitted",
          label: "Review uncommitted changes",
          description: "Review all staged and unstaged changes",
          result: "/review",
        },
        {
          id: "review-commit",
          label: "Review a commit",
          description: "Review changes in a specific commit",
          nested: {
            type: "dynamic",
            title: "Select a commit",
            loaderId: "commits",
            searchable: true,
          },
        },
        {
          id: "review-custom",
          label: "Custom review instructions",
          description: "Enter branch, commit, or PR URL",
          nested: {
            type: "input",
            title: "Enter review target",
            placeholder: "branch name, commit SHA, or PR URL...",
          },
        },
      ],
    },
  },
  {
    trigger: "new",
    title: "New",
    description: "start a new chat during a conversation",
    action: { kind: "command", id: "session.new" },
  },
  {
    trigger: "init",
    title: "Init",
    description: "create an AGENTS.md file with instructions for Codex",
  },
  {
    trigger: "compact",
    title: "Compact",
    description: "summarize conversation to prevent hitting the context limit",
    action: { kind: "summarize" },
  },
  {
    trigger: "mention",
    title: "Mention",
    description: "mention a file",
    action: { kind: "insert", text: "@", popover: "at" },
  },
  {
    trigger: "mcp",
    title: "MCP",
    description: "list configured MCP tools",
    action: { kind: "command", id: "mcp.toggle" },
  },
  {
    trigger: "feedback",
    title: "Feedback",
    description: "send logs to maintainers",
    action: { kind: "link", url: "https://opencode.ai/desktop-feedback" },
  },
]

export const CODEX_SLASH_HIDDEN = new Set([
  "model",
  "experimental",
  "skills",
  "resume",
  "logout",
  "quit",
  "exit",
  "rollout",
  "ps",
  "test-approval",
])
export const CODEX_SLASH_COMMANDS_ACTIVE = CODEX_SLASH_COMMANDS.filter((cmd) => import.meta.env.DEV || !cmd.debugOnly)
export const CODEX_SLASH_COMMANDS_BY_TRIGGER = new Map(CODEX_SLASH_COMMANDS_ACTIVE.map((cmd) => [cmd.trigger, cmd]))
export const CODEX_SLASH_COMMAND_TRIGGERS = new Set(CODEX_SLASH_COMMANDS_ACTIVE.map((cmd) => cmd.trigger))
export const CODEX_SLASH_INSERT_TRIGGERS = new Set(
  CODEX_SLASH_COMMANDS_ACTIVE.filter((cmd) => !cmd.action).map((cmd) => cmd.trigger),
)
export const CODEX_SLASH_DISABLED = new Set([...CODEX_SLASH_COMMAND_TRIGGERS, ...CODEX_SLASH_HIDDEN])
