import { describe, expect, test } from "bun:test"
import { SessionMode } from "../../src/session/mode"

describe("SessionMode", () => {
  test("detects oh-my-opencode plugin identifiers", () => {
    expect(SessionMode.isOhMyPlugin("oh-my-opencode")).toBe(true)
    expect(SessionMode.isOhMyPlugin("oh-my-opencode@2.4.3")).toBe(true)
    expect(SessionMode.isOhMyPlugin("@scope/pkg@1.0.0")).toBe(false)
  })

  test("allows Claude features outside oh-my-opencode mode", () => {
    const mode: SessionMode.Info = { id: "opencode" }
    expect(SessionMode.isClaudeFeatureEnabled(mode, "hooks")).toBe(true)
    expect(SessionMode.isClaudeFeatureEnabled(mode, "agents")).toBe(true)
  })

  test("respects oh-my-opencode Claude feature toggles", () => {
    const mode: SessionMode.Info = {
      id: "oh-my-opencode",
      settings: {
        ohMyOpenCode: {
          claudeCode: {
            hooks: false,
            agents: true,
          },
        },
      },
    }
    expect(SessionMode.isClaudeFeatureEnabled(mode, "hooks")).toBe(false)
    expect(SessionMode.isClaudeFeatureEnabled(mode, "agents")).toBe(true)
  })

  test("blocks oh-my agents outside oh-my-opencode mode", () => {
    const mode: SessionMode.Info = { id: "claude-code" }
    expect(SessionMode.isAgentAllowed(mode, "Sisyphus")).toBe(false)
    expect(SessionMode.isAgentAllowed(mode, "build")).toBe(true)
  })

  test("enforces claude-code and codex allowlists", () => {
    const claude: SessionMode.Info = { id: "claude-code" }
    const codex: SessionMode.Info = { id: "codex" }
    expect(SessionMode.isAgentAllowed(claude, "plan")).toBe(true)
    expect(SessionMode.isAgentAllowed(claude, "general")).toBe(false)
    expect(SessionMode.isAgentAllowed(codex, "plan")).toBe(true)
    expect(SessionMode.isAgentAllowed(codex, "explore")).toBe(false)
  })

  test("applies opencode disabled agents", () => {
    const mode: SessionMode.Info = { id: "opencode" }
    expect(SessionMode.isAgentAllowed(mode, "Sisyphus")).toBe(false)
    expect(SessionMode.isAgentAllowed(mode, "explore")).toBe(true)
  })

  test("defaults to blocking oh-my agents for unknown modes", () => {
    const mode: SessionMode.Info = { id: "custom-mode" }
    expect(SessionMode.isAgentAllowed(mode, "Sisyphus")).toBe(false)
    expect(SessionMode.isAgentAllowed(mode, "build")).toBe(true)
  })
})
