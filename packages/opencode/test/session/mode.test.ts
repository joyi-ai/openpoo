import { describe, expect, test } from "bun:test"
import { SessionMode } from "../../src/session/mode"

describe("SessionMode", () => {
  test("enforces claude-code allowlist", () => {
    const mode: SessionMode.Info = { id: "claude-code" }
    expect(SessionMode.isAgentAllowed(mode, "build")).toBe(true)
    expect(SessionMode.isAgentAllowed(mode, "plan")).toBe(true)
    expect(SessionMode.isAgentAllowed(mode, "general")).toBe(false)
  })

  test("enforces codex allowlist", () => {
    const mode: SessionMode.Info = { id: "codex" }
    expect(SessionMode.isAgentAllowed(mode, "build")).toBe(true)
    expect(SessionMode.isAgentAllowed(mode, "plan")).toBe(true)
    expect(SessionMode.isAgentAllowed(mode, "explore")).toBe(false)
  })

  test("allows agents for opencode", () => {
    const mode: SessionMode.Info = { id: "opencode" }
    expect(SessionMode.isAgentAllowed(mode, "build")).toBe(true)
    expect(SessionMode.isAgentAllowed(mode, "explore")).toBe(true)
  })

  test("allows agents for unknown modes", () => {
    const mode: SessionMode.Info = { id: "custom-mode" }
    expect(SessionMode.isAgentAllowed(mode, "build")).toBe(true)
    expect(SessionMode.isAgentAllowed(mode, "random-agent")).toBe(true)
  })
})
