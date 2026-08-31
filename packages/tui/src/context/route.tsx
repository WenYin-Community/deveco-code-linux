import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"
import { enterSession, leaveSession } from "./session-timer"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ??
        (process.env["DEVECO_ROUTE"]
          ? JSON.parse(process.env["DEVECO_ROUTE"])
          : initialRoute(startup.initialRoute) ?? { type: "home" }),
    )

    // Session timer: the initial route (restored from startup) may already be
    // a session — start its timer without waiting for the first navigate().
    if (store.type === "session" && "sessionID" in store) {
      enterSession(store.sessionID)
    }

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        // Session timer: close out the old session, start the new one.
        if (route.type === "session" && "sessionID" in route) {
          enterSession(route.sessionID)
        } else {
          leaveSession()
        }
        setStore(reconcile(route))
      },
    }
  },
})

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
