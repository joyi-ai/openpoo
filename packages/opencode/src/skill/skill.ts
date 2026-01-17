import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { ClaudePlugin } from "@/claude-plugin"
import { Flag } from "@/flag/flag"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
  })
  export type Info = z.infer<typeof Info>

  const Name = z.string().min(1).refine(
    (value) => {
      if (value.includes("\\")) return false
      const parts = value.split("/")
      return parts.every((part) => part && part !== "." && part !== "..")
    },
    {
      message: "Skill name must use '/' and cannot contain empty, '.' or '..' segments.",
    },
  )

  export const Location = z.enum(["opencode", "claude"])
  export type Location = z.infer<typeof Location>

  export const Create = z.object({
    name: Name,
    description: z.string().min(1),
    content: z.string().optional(),
    location: Location,
  })
  export type Create = z.infer<typeof Create>

  export const Remove = z.object({
    name: Name,
    location: Location,
  })
  export type Remove = z.infer<typeof Remove>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const OPENCODE_SKILL_GLOB = new Bun.Glob("{skill,skills}/**/SKILL.md")
  const CLAUDE_SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")

  const baseDir = (location: Location) => {
    if (location === "opencode") return path.join(Instance.directory, ".opencode", "skill")
    return path.join(Instance.directory, ".claude", "skills")
  }

  const skillPath = (location: Location, name: string) => {
    return path.join(baseDir(location), name, "SKILL.md")
  }

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}
    const sources: Record<string, "claude" | "opencode" | "claude-plugin"> = {}

    const addSkill = async (match: string, source: "claude" | "opencode") => {
      const md = await ConfigMarkdown.parse(match)
      if (!md) {
        return
      }

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // Warn on duplicate skill names
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      const name = parsed.data.name
      skills[name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
      }
      sources[name] = source
    }

    // Scan .claude/skills/ directories (project-level)
    const claudeDirs = await Array.fromAsync(
      Filesystem.up({
        targets: [".claude"],
        start: Instance.directory,
        stop: Instance.worktree,
      }),
    )
    // Also include global ~/.claude/skills/
    const globalClaude = `${Global.Path.home}/.claude`
    if (await Filesystem.exists(globalClaude)) {
      claudeDirs.push(globalClaude)
    }

    if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) {
      for (const dir of claudeDirs) {
        const matches = await Array.fromAsync(
          CLAUDE_SKILL_GLOB.scan({
            cwd: dir,
            absolute: true,
            onlyFiles: true,
            followSymlinks: true,
            dot: true,
          }),
        ).catch((error) => {
          log.error("failed .claude directory scan for skills", { dir, error })
          return []
        })

        for (const match of matches) {
          await addSkill(match, "claude")
        }
      }
    }

    // Scan .opencode/skill/ directories
    for (const dir of await Config.directories()) {
      for await (const match of OPENCODE_SKILL_GLOB.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match, "opencode")
      }
    }

    // Load skills from Claude Code plugins
    for (const skill of await ClaudePlugin.skills()) {
      if (skills[skill.name]) {
        log.warn("duplicate skill name from plugin", {
          name: skill.name,
          existing: skills[skill.name].location,
          duplicate: skill.location,
        })
        continue
      }
      skills[skill.name] = {
        name: skill.name,
        description: skill.description,
        location: skill.location,
      }
      sources[skill.name] = "claude-plugin"
    }

    return { skills, sources }
  })

  export async function get(name: string) {
    return state().then((x) => x.skills[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }

  export async function isClaudeSkill(name: string) {
    return state().then((x) => {
      const source = x.sources[name]
      if (!source) return false
      if (source === "opencode") return false
      return true
    })
  }

  export async function create(input: Create) {
    const file = skillPath(input.location, input.name)
    const dir = path.dirname(file)
    await fs.mkdir(dir, { recursive: true })
    const body = input.content ?? ""
    const output = [
      "---",
      `name: ${JSON.stringify(input.name)}`,
      `description: ${JSON.stringify(input.description)}`,
      "---",
      "",
      body,
    ].join("\n")
    await Bun.write(file, `${output.trimEnd()}\n`)
    await Instance.dispose()
    return {
      name: input.name,
      description: input.description,
      location: file,
    }
  }

  export async function remove(input: Remove) {
    const file = skillPath(input.location, input.name)
    await fs.rm(file, { force: true })
    await Instance.dispose()
    return true
  }
}
