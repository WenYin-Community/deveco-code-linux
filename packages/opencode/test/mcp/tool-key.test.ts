import { describe, expect, test } from "bun:test"
import { toolKey } from "../../src/mcp/catalog"

describe("MCP toolKey", () => {
  test("keeps a single homegraph_ prefix when the tool name already has it", () => {
    expect(toolKey("homegraph", "homegraph_project")).toBe("homegraph_project")
    expect(toolKey("homegraph", "homegraph_explore")).toBe("homegraph_explore")
    expect(toolKey("homegraph", "homegraph_project")).not.toContain("homegraph_homegraph_")
  })

  test("still prefixes tools that do not already start with the server name", () => {
    expect(toolKey("homegraph", "tool-one")).toBe("homegraph_tool-one")
    expect(toolKey("paged-server", "tool-one")).toBe("paged-server_tool-one")
  })

  test("only de-dupes the homegraph server prefix; other servers always get server_tool", () => {
    expect(toolKey("home graph", "home_graph_project")).toBe("home_graph_home_graph_project")
    expect(toolKey("verify", "verify_ui")).toBe("verify_verify_ui")
    expect(toolKey("other server", "read")).toBe("other_server_read")
  })
})
