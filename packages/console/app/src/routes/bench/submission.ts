import type { APIEvent } from "@solidjs/start/server"
import { Database } from "@opencode-ai/console-core/drizzle/index.js"
import { BenchmarkTable } from "@opencode-ai/console-core/schema/benchmark.sql.js"
import { Identifier } from "@opencode-ai/console-core/identifier.js"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { getActor } from "~/context/auth"
import { z } from "zod"

const SubmissionSchema = z.object({
  model: z.string().min(1).max(64),
  agent: z.string().min(1).max(64),
  result: z.string().min(1).refine((s) => { try { JSON.parse(s); return true } catch { return false } }),
})

export async function POST(event: APIEvent) {
  const dict = i18n(localeFromRequest(event.request))
  const actor = await getActor()
  if (actor.type === "public") {
    return Response.json({ error: dict["bench.submission.error.unauthorized"] }, { status: 401 })
  }

  const parsed = SubmissionSchema.safeParse(await event.request.json())
  if (!parsed.success) {
    return Response.json({ error: dict["bench.submission.error.allFieldsRequired"] }, { status: 400 })
  }
  const body = parsed.data

  await Database.use((tx) =>
    tx.insert(BenchmarkTable).values({
      id: Identifier.create("benchmark"),
      model: body.model,
      agent: body.agent,
      result: body.result,
    }),
  )

  return Response.json({ success: true }, { status: 200 })
}
