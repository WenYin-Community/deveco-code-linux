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
      resolveSubagentParent?: (sessionId: string) => string | undefined
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
    // Task-tool subagents are not ACP-registered sessions; their questions
    // are re-targeted to the owning parent session so the client actually
    // sees them. A dropped question used to leave the subagent waiting forever.
    const parentId = this.input.resolveSubagentParent?.(question.sessionID)
    const session = await Effect.runPromise(this.input.session.tryGet(parentId ?? question.sessionID))
    if (!session) return
    const clientSessionId = parentId ?? question.sessionID

    if (question.questions.length === 0) return
    const fields = question.questions.map((item, index) => ({ key: `question_${index}`, question: item }))
const result = await this.input.connection
      .unstable_createElicitation(buildElicitationRequest(clientSessionId, question, fields))
      .catch(async () => {
        await this.reject(question.id, session.cwd)
        return undefined
      })
    if (!result) return

    if (result.action === "accept" && result.content) {
      await this.reply(question.id, collectAnswers(result.content, fields), session.cwd)
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

type Field = { key: string; question: QuestionEvent["properties"]["questions"][number] }

function buildElicitationRequest(sessionId: string, question: QuestionEvent["properties"], fields: Field[]): CreateElicitationRequest {
  const properties = Object.fromEntries(fields.map((field) => [field.key, propertySchema(field)]))
  const metaFields = fields.map((field) => ({
    key: field.key,
    custom: field.question.custom !== false,
    options: field.question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
  }))
  const title = question.questions[0]?.header || "Question"
  return {
    sessionId,
    mode: "form",
    message: title,
    requestedSchema: {
      type: "object",
      title,
      properties,
      required: fields.map((field) => field.key),
    },
    _meta: { "deveco.question": { fields: metaFields } },
  }
}

function propertySchema(field: Field) {
  const options = field.question.options.map((option) => ({ const: option.label, title: option.label }))
  if (field.question.multiple) {
    return {
      type: "array" as const,
      title: field.question.header,
      description: field.question.question,
      items: { anyOf: options },
    }
  }
  return {
    type: "string" as const,
    title: field.question.header,
    description: field.question.question,
    ...(field.question.options.length > 0 ? { oneOf: options } : {}),
  }
}

function collectAnswers(content: unknown, fields: Field[]): string[][] {
  const contentValues = content as Record<string, unknown>
  return fields.map((field) => {
    const value = contentValues[field.key]
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
    return []
  })
}

export * as ACPElicitation from "./elicitation"
