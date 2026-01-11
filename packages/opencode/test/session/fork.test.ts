import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session.fork", () => {
  test("should preserve message order and parent links", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id

        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
          time: {
            created: Date.now(),
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID,
          type: "text",
          text: "First message",
        })

        const assistant1: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: user1.id,
          time: {
            created: Date.now(),
          },
          finish: "end_turn",
        }
        await Session.updateMessage(assistant1)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant1.id,
          sessionID,
          type: "text",
          text: "First reply",
        })

        const user2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
          time: {
            created: Date.now(),
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user2.id,
          sessionID,
          type: "text",
          text: "Second message",
        })

        const assistant2: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: user2.id,
          time: {
            created: Date.now(),
          },
          finish: "end_turn",
        }
        await Session.updateMessage(assistant2)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant2.id,
          sessionID,
          type: "text",
          text: "Second reply",
        })

        const forked = await Session.fork({ sessionID })
        const original = await Session.messages({ sessionID })
        const forkedMessages = await Session.messages({ sessionID: forked.id })

        expect(forkedMessages.length).toBe(original.length)
        expect(forkedMessages.map((m) => m.info.role)).toEqual(original.map((m) => m.info.role))

        const forkedUserIds = forkedMessages.filter((m) => m.info.role === "user").map((m) => m.info.id)
        const forkedAssistants = forkedMessages
          .filter((m) => m.info.role === "assistant")
          .map((m) => m.info as MessageV2.Assistant)

        expect(forkedUserIds.length).toBe(2)
        expect(forkedAssistants.length).toBe(2)
        expect(forkedAssistants[0].parentID).toBe(forkedUserIds[0])
        expect(forkedAssistants[1].parentID).toBe(forkedUserIds[1])

        const forkedIds = forkedMessages.map((m) => m.info.id)
        const sortedIds = forkedIds.slice().sort((a, b) => a.localeCompare(b))
        expect(forkedIds).toEqual(sortedIds)

        await Session.remove({ sessionID })
        await Session.remove({ sessionID: forked.id })
      },
    })
  })
})
