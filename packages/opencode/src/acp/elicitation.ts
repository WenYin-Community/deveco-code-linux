import type { AgentSideConnection, CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "./session"

type QuestionEvent = Extract<Event, { type: "question.asked" }>
type Connection = Pick<AgentSideConnection, "unstable_createElicitation">

export class Handler {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly input: {
      sdk: OpencodeClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {}

  handle(event: QuestionEvent) {
    const question = event.properties
    const previous = this.queues.get(question.sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(question.sessionID) === next) {
          this.queues.delete(question.sessionID)
        }
      })
    this.queues.set(question.sessionID, next)
  }

  private async process(event: QuestionEvent) {
    const question = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(question.sessionID))
    if (!session) return

    if (question.questions.length === 0) return
    const fields = question.questions.map((item, index) => ({ key: `question_${index}`, question: item }))
    const properties = Object.fromEntries(
      fields.map((field) => [
        field.key,
        field.question.multiple
          ? {
              type: "array" as const,
              title: field.question.header,
              description: field.question.question,
              items: {
                anyOf: field.question.options.map((option) => ({ const: option.label, title: option.label })),
              },
            }
          : {
              type: "string" as const,
              title: field.question.header,
              description: field.question.question,
              ...(field.question.options.length > 0
                ? {
                    oneOf: field.question.options.map((option) => ({ const: option.label, title: option.label })),
                  }
                : {}),
            },
      ]),
    )

    const request: CreateElicitationRequest = {
      sessionId: question.sessionID,
      mode: "form",
      message: question.questions[0]?.header || "Question",
      requestedSchema: {
        type: "object",
        title: question.questions[0]?.header || "Question",
        properties,
        required: fields.map((field) => field.key),
      },
      _meta: {
        "deveco.question": {
          fields: fields.map((field) => ({
            key: field.key,
            custom: field.question.custom !== false,
            options: field.question.options.map((option) => ({
              value: option.label,
              label: option.label,
              description: option.description,
            })),
          })),
        },
      },
    }

    const result = await this.input.connection
      .unstable_createElicitation(request)
      .catch(async () => {
        await this.reject(question.id, session.cwd)
        return undefined
      })

    if (!result) return

    if (result.action === "accept" && result.content) {
      const contentValues = result.content as Record<string, unknown>
      const answers = fields.map((field) => {
        const value = contentValues[field.key]
        if (typeof value === "string") return [value]
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
        return []
      })
      await this.reply(question.id, answers, session.cwd)
    } else {
      await this.reject(question.id, session.cwd)
    }
  }

  private async reply(requestID: string, answers: string[][], directory: string) {
    await this.input.sdk.question.reply({
      requestID,
      answers,
      directory,
    })
  }

  private async reject(requestID: string, directory: string) {
    await this.input.sdk.question.reject({
      requestID,
      directory,
    })
  }
}

export * as ACPElicitation from "./elicitation"
