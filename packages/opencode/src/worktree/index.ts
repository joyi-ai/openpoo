import { $ } from "bun"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "@/util/log"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Project } from "@/project/project"
import { State } from "@/project/state"

const log = Log.create({ service: "worktree" })

const ADJECTIVES = [
  "bright",
  "calm",
  "cool",
  "dark",
  "dry",
  "fast",
  "flat",
  "free",
  "fresh",
  "full",
  "gold",
  "green",
  "high",
  "kind",
  "late",
  "lean",
  "long",
  "loud",
  "low",
  "neat",
  "new",
  "old",
  "pale",
  "pure",
  "quick",
  "rare",
  "raw",
  "red",
  "rich",
  "safe",
  "slow",
  "soft",
  "strong",
  "sweet",
  "tall",
  "thin",
  "warm",
  "wide",
  "wild",
  "young",
]

const NOUNS = [
  "arc",
  "bay",
  "beam",
  "bird",
  "brook",
  "bush",
  "cloud",
  "cove",
  "creek",
  "dawn",
  "dew",
  "dusk",
  "fern",
  "fire",
  "flame",
  "flower",
  "fog",
  "frost",
  "gale",
  "galaxy",
  "gem",
  "grove",
  "haze",
  "hill",
  "lake",
  "leaf",
  "light",
  "meadow",
  "moon",
  "moss",
  "oak",
  "peak",
  "pine",
  "pond",
  "rain",
  "ridge",
  "river",
  "rock",
  "rose",
  "sky",
  "snow",
  "star",
  "stone",
  "stream",
  "sun",
  "tide",
  "tree",
  "valley",
  "wave",
  "wind",
  "wood",
]

export namespace Worktree {
  export const Info = z
    .object({
      name: z.string(),
      branch: z.string(),
      directory: z.string(),
    })
    .meta({ ref: "Worktree" })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z
    .object({
      name: z.string().optional(),
      startCommand: z.string().optional(),
    })
    .meta({ ref: "WorktreeCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const NotGitProjectError = NamedError.create(
    "WorktreeNotGitProjectError",
    z.object({
      message: z.string(),
      directory: z.string(),
    }),
  )

  export const CreateFailedError = NamedError.create(
    "WorktreeCreateFailedError",
    z.object({
      message: z.string(),
      directory: z.string(),
      output: z.string().optional(),
    }),
  )

  export const StartCommandFailedError = NamedError.create(
    "WorktreeStartCommandFailedError",
    z.object({
      message: z.string(),
      directory: z.string(),
      command: z.string(),
      output: z.string().optional(),
    }),
  )

  export const DeleteFailedError = NamedError.create(
    "WorktreeDeleteFailedError",
    z.object({
      message: z.string(),
      directory: z.string(),
      output: z.string().optional(),
    }),
  )

  export const NotFoundError = NamedError.create(
    "WorktreeNotFoundError",
    z.object({
      message: z.string(),
      directory: z.string(),
    }),
  )

  function slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
  }

  function generateName(base?: string): string {
    const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
    if (base) {
      const slug = slugify(base)
      if (slug) return `${slug}-${adjective}-${noun}`
    }
    return `${adjective}-${noun}`
  }

  function managedRoot(): string {
    return path.normalize(path.join(Global.Path.data, "worktree"))
  }

  function normalizeCase(input: string): string {
    if (process.platform !== "win32") return input
    return input.toLowerCase()
  }

  function normalizePath(input: string): string {
    return normalizeCase(path.normalize(input))
  }

  function resolveCommonDir(input: string, cwd: string): string | undefined {
    if (!input) return
    if (path.isAbsolute(input)) return path.normalize(input)
    return path.normalize(path.resolve(cwd, input))
  }

  async function listWorktrees(root: string): Promise<string[]> {
    const output = await $`git worktree list --porcelain`.quiet().nothrow().cwd(root).text().catch(() => "")
    if (!output) return []
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean)
      .map((line) => (path.isAbsolute(line) ? line : path.resolve(root, line)))
      .map((line) => path.normalize(line))
  }

  async function unsandbox(directory: string) {
    const items = await Project.list()
    const target = normalizePath(directory)
    for (const project of items) {
      const sandboxes = project.sandboxes ?? []
      for (const sandbox of sandboxes) {
        if (normalizePath(sandbox) !== target) continue
        await Project.removeSandbox(project.id, sandbox)
      }
    }
  }

  async function branchExists(branch: string, cwd: string): Promise<boolean> {
    const result = await $`git show-ref --verify --quiet refs/heads/${branch}`.quiet().nothrow().cwd(cwd)
    return result.exitCode === 0
  }

  async function findUniqueName(
    projectID: string,
    baseName: string | undefined,
    worktreeRoot: string,
  ): Promise<{ name: string; directory: string; branch: string }> {
    const maxAttempts = 26

    for (let i = 0; i < maxAttempts; i++) {
      const name = generateName(baseName)
      const directory = path.join(Global.Path.data, "worktree", projectID, name)
      const branch = `opencode/${name}`

      const dirExists = await fs.stat(directory).catch(() => undefined)
      if (dirExists) continue

      const refExists = await branchExists(branch, worktreeRoot)
      if (refExists) continue

      return { name, directory, branch }
    }

    throw new CreateFailedError({
      message: `Failed to generate unique worktree name after ${maxAttempts} attempts`,
      directory: worktreeRoot,
    })
  }

  export async function create(input: CreateInput = {}): Promise<Info> {
    const project = Instance.project
    const worktreeRoot = Instance.worktree

    if (project.vcs !== "git") {
      throw new NotGitProjectError({
        message: "Worktrees are only supported for git projects",
        directory: Instance.directory,
      })
    }

    const { name, directory, branch } = await findUniqueName(project.id, input.name, worktreeRoot)

    log.info("creating worktree", { name, directory, branch, project: project.id })

    await fs.mkdir(path.dirname(directory), { recursive: true })

    const result = await $`git worktree add -b ${branch} ${directory}`.quiet().nothrow().cwd(worktreeRoot)

    if (result.exitCode !== 0) {
      const output = result.stderr.toString() || result.stdout.toString()
      throw new CreateFailedError({
        message: `Failed to create git worktree: ${output}`,
        directory: worktreeRoot,
        output,
      })
    }

    log.info("worktree created", { name, directory, branch })

    if (input.startCommand) {
      log.info("running start command", { command: input.startCommand, directory })
      const cmdResult = await $`${{ raw: input.startCommand }}`.quiet().nothrow().cwd(directory)

      if (cmdResult.exitCode !== 0) {
        const output = cmdResult.stderr.toString() || cmdResult.stdout.toString()
        throw new StartCommandFailedError({
          message: `Start command failed: ${output}`,
          directory,
          command: input.startCommand,
          output,
        })
      }
    }

    await Project.addSandbox(project.id, directory)

    return {
      name,
      branch,
      directory,
    }
  }

  export async function list(): Promise<string[]> {
    const project = Instance.project
    return Project.sandboxes(project.id)
  }

  export function isManaged(directory: string): boolean {
    const normalized = path.normalize(directory)
    const root = managedRoot()
    const candidate = normalizeCase(normalized)
    const rootKey = normalizeCase(root)
    return candidate.startsWith(rootKey + path.sep)
  }

  export async function remove(directory: string): Promise<boolean> {
    const normalized = path.normalize(directory)
    const stat = await fs.stat(normalized).catch(() => undefined)
    if (!stat?.isDirectory()) {
      throw new NotFoundError({
        message: "Worktree directory does not exist",
        directory,
      })
    }

    const target = normalizePath(normalized)
    const projects = await Project.list()
    const main = projects.some((project) => normalizePath(project.worktree) === target)
    if (main) {
      throw new DeleteFailedError({
        message: "Cannot delete main worktree",
        directory,
      })
    }

    const sandboxed = projects.some((project) => {
      const sandboxes = project.sandboxes ?? []
      return sandboxes.some((sandbox) => normalizePath(sandbox) === target)
    })
    const managed = isManaged(normalized)
    const known = sandboxed || managed

    const gitCommonDir = await $`git rev-parse --git-common-dir`
      .quiet()
      .nothrow()
      .cwd(normalized)
      .text()
      .then((x) => x.trim())
      .catch(() => undefined)

    const common = resolveCommonDir(gitCommonDir ?? "", normalized)
    const root =
      (common ? path.dirname(common) : undefined) ??
      (() => {
        for (const project of projects) {
          const sandboxes = project.sandboxes ?? []
          for (const sandbox of sandboxes) {
            if (normalizePath(sandbox) === target) return project.worktree
          }
          const base = normalizePath(path.join(Global.Path.data, "worktree", project.id))
          if (target.startsWith(base + path.sep)) return project.worktree
        }
      })()

    const rootKey = root ? normalizePath(root) : undefined
    if (rootKey && rootKey === target) {
      throw new DeleteFailedError({
        message: "Cannot delete main worktree",
        directory,
      })
    }

    const listed = root ? await listWorktrees(root) : []
    const present = listed.some((item) => normalizePath(item) === target)
    const allowed = present || known
    if (!allowed) {
      throw new DeleteFailedError({
        message: "Not a valid git worktree",
        directory,
      })
    }

    const disposeTargets = new Set<string>([directory, normalized])
    for (const target of disposeTargets) {
      await State.dispose(target).catch((error) => {
        log.warn("failed to dispose instance state", { directory: target, error })
      })
    }

    const maxAttempts = 5
    const attempts = Array.from({ length: maxAttempts }, (_value, index) => index)
    for (const attempt of attempts) {
      if (root) {
        const removeResult = await $`git worktree remove --force ${normalized}`.quiet().nothrow().cwd(root)
        if (removeResult.exitCode === 0) {
          await unsandbox(normalized)
          log.info("worktree removed", { directory: normalized })
          return true
        }

        const output = removeResult.stderr.toString() || removeResult.stdout.toString()
        const last = attempt === maxAttempts - 1
        if (!last) {
          const delay = 500 * 2 ** attempt
          log.info("worktree removal failed, retrying", { directory: normalized, attempt, delay, output })
          await Bun.sleep(delay)
          continue
        }

        log.warn("git worktree remove failed after retries", { directory: normalized, output })
      }
    }

    log.warn("git worktree remove failed after retries, attempting manual cleanup", { directory: normalized })
    const removed = await fs
      .rm(normalized, { recursive: true, force: true })
      .then(() => true)
      .catch((error) => {
        log.error("failed to remove worktree directory", { directory: normalized, error })
        return false
      })
    if (!removed) return false

    if (root) {
      const pruneResult = await $`git worktree prune`.quiet().nothrow().cwd(root)
      if (pruneResult.exitCode !== 0) {
        const output = pruneResult.stderr.toString() || pruneResult.stdout.toString()
        log.warn("git worktree prune failed after manual cleanup", { directory: normalized, output })
      }
    }

    await unsandbox(normalized)
    log.info("worktree removed via manual cleanup", { directory: normalized })
    return true
  }
}
