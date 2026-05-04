import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { paramToAttributeKey, requestAttributes, runRequestDeferred } from "../../src/server/routes/instance/trace"

function fakeContext(method: string, url: string, params: Record<string, string>) {
  return {
    req: {
      method,
      url,
      param: () => params,
    },
  }
}

describe("paramToAttributeKey", () => {
  test("converts fooID to foo.id", () => {
    expect(paramToAttributeKey("sessionID")).toBe("session.id")
    expect(paramToAttributeKey("messageID")).toBe("message.id")
    expect(paramToAttributeKey("partID")).toBe("part.id")
    expect(paramToAttributeKey("projectID")).toBe("project.id")
    expect(paramToAttributeKey("providerID")).toBe("provider.id")
    expect(paramToAttributeKey("ptyID")).toBe("pty.id")
    expect(paramToAttributeKey("permissionID")).toBe("permission.id")
    expect(paramToAttributeKey("requestID")).toBe("request.id")
    expect(paramToAttributeKey("workspaceID")).toBe("workspace.id")
  })

  test("namespaces non-ID params under opencode.", () => {
    expect(paramToAttributeKey("name")).toBe("opencode.name")
    expect(paramToAttributeKey("slug")).toBe("opencode.slug")
  })
})

describe("requestAttributes", () => {
  test("includes http method and path", () => {
    const attrs = requestAttributes(fakeContext("GET", "http://localhost/session", {}))
    expect(attrs["http.method"]).toBe("GET")
    expect(attrs["http.path"]).toBe("/session")
  })

  test("strips query string from path", () => {
    const attrs = requestAttributes(fakeContext("GET", "http://localhost/file/search?query=foo&limit=10", {}))
    expect(attrs["http.path"]).toBe("/file/search")
  })

  test("emits OTel-style <domain>.id for ID-shaped route params", () => {
    const attrs = requestAttributes(
      fakeContext("GET", "http://localhost/session/ses_abc/message/msg_def/part/prt_ghi", {
        sessionID: "ses_abc",
        messageID: "msg_def",
        partID: "prt_ghi",
      }),
    )
    expect(attrs["session.id"]).toBe("ses_abc")
    expect(attrs["message.id"]).toBe("msg_def")
    expect(attrs["part.id"]).toBe("prt_ghi")
    // No camelCase leftovers:
    expect(attrs["opencode.sessionID"]).toBeUndefined()
    expect(attrs["opencode.messageID"]).toBeUndefined()
    expect(attrs["opencode.partID"]).toBeUndefined()
  })

  test("produces no param attributes when no params are matched", () => {
    const attrs = requestAttributes(fakeContext("POST", "http://localhost/config", {}))
    expect(Object.keys(attrs).filter((k) => k !== "http.method" && k !== "http.path")).toEqual([])
  })

  test("namespaces non-ID params under opencode. (e.g. mcp :name)", () => {
    const attrs = requestAttributes(
      fakeContext("POST", "http://localhost/mcp/exa/connect", {
        name: "exa",
      }),
    )
    expect(attrs["opencode.name"]).toBe("exa")
    expect(attrs["name"]).toBeUndefined()
  })
})

describe("runRequestDeferred", () => {
  test("does not start the effect until after the current request handler yields", async () => {
    let started = false
    let failed: unknown
    runRequestDeferred(
      "test.deferred",
      fakeContext("POST", "http://localhost/session/ses_abc/prompt_async", { sessionID: "ses_abc" }) as any,
      Effect.sync(() => {
        started = true
      }) as any,
      (error) => {
        failed = error
      },
    )

    expect(started).toBe(false)
    for (let attempt = 0; attempt < 40 && !started && !failed; attempt++) {
      await Bun.sleep(25)
    }
    expect(failed).toBeUndefined()
    expect(started).toBe(true)
  })
})
