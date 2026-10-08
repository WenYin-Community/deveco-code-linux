import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

// Per-subscriber backlog cap; an overflowing SSE subscriber is failed with
// SubscriberOverflowError instead of growing the heap without bound.
const subscriberCapacity = 256

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          location: new Location.Info({
            directory: location.directory,
            workspaceID: location.workspaceID,
            project: location.project,
          }),
          data: {},
        }
        // Acquiring the bounded stream installs its listener before readiness is observable.
        const live = yield* EventV2.allBounded(events, subscriberCapacity)
        return HttpServerResponse.stream(
          Stream.make(connected).pipe(
            Stream.concat(
              live.pipe(
                Stream.filter(
                  (event) =>
                    event.location?.directory === location.directory &&
                    event.location.workspaceID === location.workspaceID,
                ),
              ),
            ),
            Stream.map(eventData),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
