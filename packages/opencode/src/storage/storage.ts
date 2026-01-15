import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { $ } from "bun"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { StorageSqlite } from "./sqlite"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of new Bun.Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Bun.file(msgFile).json()
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const [id] = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(worktree)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
          if (!id) continue
          projectID = id

          await Bun.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Bun.file(sessionFile).json()
            await Bun.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Bun.file(msgFile).json()
              await Bun.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Bun.Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan(
                {
                  cwd: fullProjectDir,
                  absolute: true,
                },
              )) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Bun.file(partFile).json()
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Bun.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Bun.Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Bun.file(item).json()
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Bun.file(path.join(dir, "session_diff", session.id + ".json")).write(JSON.stringify(diffs))
        await Bun.file(path.join(dir, "session", session.projectID, session.id + ".json")).write(
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
    // Migration 3: Consolidate parts inline with messages
    async (dir) => {
      log.info("migrating parts to inline format")
      const messageGlob = new Bun.Glob("**/*.json")
      const messagesDir = path.join(dir, "message")

      // Check if message directory exists
      if (!(await Filesystem.exists(messagesDir))) {
        log.info("no messages directory found, skipping migration")
        return
      }

      // Find all message files
      for await (const msgPath of messageGlob.scan({
        cwd: messagesDir,
        absolute: true,
      })) {
        const message = await Bun.file(msgPath)
          .json()
          .catch(() => null)
        if (!message) continue

        // Check if already migrated (has info and parts structure)
        if (message.info && Array.isArray(message.parts)) {
          continue
        }

        // This is old format - message is the info directly
        const info = message
        if (!info.id || !info.sessionID) continue

        const messageID = info.id
        const partsDir = path.join(dir, "part", messageID)

        // Collect parts from separate files
        const parts: any[] = []
        if (await Filesystem.exists(partsDir)) {
          for await (const partPath of messageGlob.scan({
            cwd: partsDir,
            absolute: true,
          })) {
            const part = await Bun.file(partPath)
              .json()
              .catch(() => null)
            if (part) parts.push(part)
          }
        }

        // Sort parts by ID
        parts.sort((a, b) => (a.id > b.id ? 1 : -1))

        // Write new format
        await Bun.write(msgPath, JSON.stringify({ info, parts }, null, 2))
        log.info(`migrated message ${messageID} with ${parts.length} parts`)

        // Remove old part files
        if (await Filesystem.exists(partsDir)) {
          await fs.rm(partsDir, { recursive: true }).catch(() => {})
        }
      }

      // Clean up empty part directories
      const partDir = path.join(dir, "part")
      if (await Filesystem.exists(partDir)) {
        const remaining = await fs.readdir(partDir).catch(() => [])
        if (remaining.length === 0) {
          await fs.rm(partDir, { recursive: true }).catch(() => {})
        }
      }

      log.info("parts migration completed")
    },
  ]

  async function migrateToSqlite(dir: string) {
    const metaKey = "sqlite-migrated"
    const migrated = StorageSqlite.metaGet(metaKey)
    if (migrated) return

    for await (const sessionFile of new Bun.Glob("session/*/*.json").scan({ cwd: dir, absolute: true })) {
      const session = await Bun.file(sessionFile)
        .json()
        .catch(() => undefined)
      if (session) StorageSqlite.writeSession(session)
    }

    for await (const messageFile of new Bun.Glob("message/*/*.json").scan({ cwd: dir, absolute: true })) {
      const message = await Bun.file(messageFile)
        .json()
        .catch(() => undefined)
      if (!message) continue
      if (message.info?.id && message.info?.sessionID) {
        StorageSqlite.writeMessage({ info: message.info })
        const inlineParts = Array.isArray(message.parts) ? (message.parts as StorageSqlite.PartRecord[]) : []
        StorageSqlite.writeParts(message.info.sessionID, message.info.id, inlineParts)
        continue
      }
      if (!message.id || !message.sessionID) continue
      const partsDir = path.join(dir, "part", message.id)
      const parts: StorageSqlite.PartRecord[] = []
      if (await Filesystem.exists(partsDir)) {
        for await (const partFile of new Bun.Glob("*.json").scan({ cwd: partsDir, absolute: true })) {
          const part = await Bun.file(partFile)
            .json()
            .catch(() => undefined)
          if (part) parts.push(part as StorageSqlite.PartRecord)
        }
      }
      parts.sort((a, b) => (a.id > b.id ? 1 : -1))
      StorageSqlite.writeMessage({ info: message })
      StorageSqlite.writeParts(message.sessionID, message.id, parts)
    }

    for await (const diffFile of new Bun.Glob("session_diff/*.json").scan({ cwd: dir, absolute: true })) {
      const diffs = await Bun.file(diffFile)
        .json()
        .catch(() => undefined)
      if (diffs === undefined) continue
      const sessionID = path.basename(diffFile, ".json")
      StorageSqlite.writeDiff(sessionID, diffs)
    }

    StorageSqlite.metaSet(metaKey, "1")
  }

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      await Bun.write(path.join(dir, "migration"), (index + 1).toString())
    }
    await migrateToSqlite(dir)
    StorageSqlite.ensureSessionIndex()
    StorageSqlite.ensureMessagePartTypes()
    return {
      dir,
    }
  })

  function isMessageKey(key: string[]) {
    return key.length === 3 && key[0] === "message"
  }

  function isMessageListKey(key: string[]) {
    return key.length === 2 && key[0] === "message"
  }

  function isSessionKey(key: string[]) {
    return key.length === 3 && key[0] === "session"
  }

  function isSessionListKey(key: string[]) {
    return key.length === 2 && key[0] === "session"
  }

  function isSessionDiffKey(key: string[]) {
    return key.length === 2 && key[0] === "session_diff"
  }

  function isMessageInfo(value: unknown): value is StorageSqlite.MessageRecord["info"] {
    if (!value || typeof value !== "object") return false
    if (!("id" in value)) return false
    if (!("sessionID" in value)) return false
    const id = (value as { id?: unknown }).id
    if (typeof id !== "string") return false
    const sessionID = (value as { sessionID?: unknown }).sessionID
    if (typeof sessionID !== "string") return false
    return true
  }

  function getMessageInfo(value: unknown) {
    if (!value || typeof value !== "object") return
    if (!("info" in value)) return
    const info = (value as { info?: unknown }).info
    if (!isMessageInfo(info)) return
    return info
  }

  async function removeLegacy(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch(() => {})
    })
  }

  async function readLegacy<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Bun.file(target).json()
      return result as T
    })
  }

  async function updateLegacy<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Bun.file(target).json()
      fn(content)
      await Bun.write(target, JSON.stringify(content, null, 2))
      return content as T
    })
  }

  async function writeLegacy<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await Bun.write(target, JSON.stringify(content, null, 2))
    })
  }

  export async function remove(key: string[]) {
    await state()
    if (isMessageKey(key)) {
      StorageSqlite.removeMessage(key[1], key[2])
      return
    }
    if (isSessionKey(key)) {
      StorageSqlite.removeSession(key[2])
      return
    }
    if (isSessionDiffKey(key)) {
      StorageSqlite.removeDiff(key[1])
      return
    }
    return removeLegacy(key)
  }

  export async function read<T>(key: string[]) {
    await state()
    if (isMessageKey(key)) {
      const row = StorageSqlite.readMessage(key[1], key[2])
      if (row !== undefined) return row as T
      throw new NotFoundError({ message: `Resource not found: ${key.join("/")}` })
    }
    if (isSessionKey(key)) {
      const row = StorageSqlite.readSession(key[2])
      if (row !== undefined) return row as T
      throw new NotFoundError({ message: `Resource not found: ${key.join("/")}` })
    }
    if (isSessionDiffKey(key)) {
      const row = StorageSqlite.readDiff(key[1])
      if (row !== undefined) return row as T
      throw new NotFoundError({ message: `Resource not found: ${key.join("/")}` })
    }
    return readLegacy<T>(key)
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    await state()
    if (isSessionKey(key)) {
      const current = StorageSqlite.readSession(key[2])
      if (current === undefined) {
        throw new NotFoundError({ message: `Resource not found: ${key.join("/")}` })
      }
      const draft = current as T
      fn(draft)
      StorageSqlite.writeSession(draft as StorageSqlite.SessionRecord)
      return draft
    }
    return updateLegacy<T>(key, fn)
  }

  export async function write<T>(key: string[], content: T) {
    await state()
    if (isMessageKey(key)) {
      const info = getMessageInfo(content)
      if (info) {
        StorageSqlite.writeMessage({ info })
        return
      }
      if (isMessageInfo(content)) {
        StorageSqlite.writeMessage({ info: content })
        return
      }
      return
    }
    if (isSessionKey(key)) {
      StorageSqlite.writeSession(content as StorageSqlite.SessionRecord)
      return
    }
    if (isSessionDiffKey(key)) {
      StorageSqlite.writeDiff(key[1], content)
      return
    }
    return writeLegacy(key, content)
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  const glob = new Bun.Glob("**/*")
  async function listLegacy(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    const result = await Array.fromAsync(
      glob.scan({
        cwd: path.join(dir, ...prefix),
        onlyFiles: true,
      }),
    )
      .then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      .catch(() => [] as string[][])
    result.sort()
    return result
  }

  export async function listMessageIDs(input: { sessionID: string; limit?: number; afterID?: string }) {
    await state()
    return StorageSqlite.listMessagesPage({
      sessionID: input.sessionID,
      limit: input.limit,
      afterID: input.afterID,
    })
  }

  export async function list(prefix: string[]) {
    await state()
    if (isMessageListKey(prefix)) {
      const sessionID = prefix[1]
      const rows = StorageSqlite.listMessages(sessionID)
      return rows.map((id) => [prefix[0], sessionID, id])
    }
    if (isSessionListKey(prefix)) {
      const projectID = prefix[1]
      const rows = StorageSqlite.listSessions(projectID)
      return rows.map((id) => [prefix[0], projectID, id])
    }
    return listLegacy(prefix)
  }
}
