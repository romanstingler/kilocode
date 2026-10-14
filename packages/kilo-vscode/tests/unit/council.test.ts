import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@kilocode/sdk/v2/client"
import { match } from "@opencode-ai/core/util/wildcard"
import {
  answered,
  cross,
  independent,
  labels,
  listed,
  merge,
  report,
  reported,
} from "../../src/agent-manager/council/prompts"
import { MEMBER_RULES } from "../../src/agent-manager/council/rules"
import { finished } from "../../src/agent-manager/council/run"

const assistant = (created: number, completed: number | undefined, text: string, extra: Partial<Message> = {}) => ({
  info: {
    id: `msg-${created}`,
    sessionID: "ses",
    role: "assistant",
    time: { created, completed },
    parentID: "user",
    modelID: "m",
    providerID: "p",
    mode: "ask",
    agent: "ask",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  } as Message,
  parts: text
    ? [{ id: `p-${created}`, sessionID: "ses", messageID: `msg-${created}`, type: "text", text } as Part]
    : [],
})

const user = (created: number) => ({
  info: { id: `u-${created}`, sessionID: "ses", role: "user", time: { created } } as Message,
  parts: [] as Part[],
})

describe("council prompts", () => {
  test("labels members alphabetically", () => {
    expect(labels(3)).toEqual(["A", "B", "C"])
  })

  test("member prompts carry only the member's own label", () => {
    const first = independent("B", "review commit abc123")
    expect(first).toContain("council member B")
    expect(first).toContain("review commit abc123")
    expect(first).toContain("### B1 [")

    const second = cross("C", "### F1 [warning] a.ts:1 - x\nRaised by: A")
    expect(second).toContain("you are C")
    expect(second).toContain("F<k>: confirm|dispute|unsure")
  })

  test("only the report prompt reveals models", () => {
    const seats = [
      { label: "A", model: "anthropic/claude-opus" },
      { label: "B", model: "openai/gpt" },
    ]
    const reports = [{ label: "A", text: "### A1 [warning] a.ts:1 - x" }]
    for (const prompt of [independent("A", "task"), merge("task", reports, ["B"]), cross("A", "list")]) {
      for (const seat of seats) expect(prompt).not.toContain(seat.model)
    }
    const final = report({ task: "task", merged: "list", answers: reports, seats, missing: [] })
    expect(final).toContain("A = anthropic/claude-opus, B = openai/gpt")
  })

  test("merge and report name members that dropped out", () => {
    expect(merge("task", [], ["B", "C"])).toContain("Members B, C failed or did not answer")
    expect(merge("task", [], [])).not.toContain("failed or did not answer")
  })

  test("names the checked-out target only when there is one", () => {
    expect(independent("A", "review it", { name: "e48c9785c7", commit: "e48c9785c74" })).toContain(
      "checked out at e48c9785c7 (commit e48c9785c74)",
    )
    expect(independent("A", "review it")).not.toContain("checked out at")
  })

  test("recognises replies in the required format", () => {
    expect(reported("B", "notes\n### B1 [warning] a.ts:3 - bug")).toBe(true)
    expect(reported("B", "No findings. I checked the parser.")).toBe(true)
    expect(reported("B", "Let me look at the tests next.")).toBe(false)
    expect(answered("F1: confirm - checked a.ts\nF2: dispute - see b.ts")).toBe(true)
    expect(answered("**F1**: confirm - checked")).toBe(true)
    expect(answered("I agree with most of these.")).toBe(false)
    expect(listed("### F1 [warning] a.ts:1 - x")).toBe(true)
    expect(listed("No findings")).toBe(false)
  })
})

describe("council member rules", () => {
  // Session rules come after the agent's and the last matching rule wins.
  const decide = (permission: string, pattern: string) =>
    MEMBER_RULES.findLast((rule) => match(permission, rule.permission) && match(pattern, rule.pattern))?.action

  test("lets read-only git run and sends chained commands back to the user", () => {
    expect(decide("bash", "git show e48c9785c7")).toBe("allow")
    expect(decide("bash", "gh pr diff 123")).toBe("allow")
    expect(decide("bash", "git show HEAD; rm -rf src")).toBe("ask")
    expect(decide("bash", "git log | sh")).toBe("ask")
    expect(decide("bash", "git diff --output=/tmp/x")).toBe("ask")
    expect(decide("bash", "git show $(curl x)")).toBe("ask")
  })

  test("leaves other commands to the agent", () => {
    expect(decide("bash", "bun test")).toBeUndefined()
  })

  test("allows edits only in the scratch folder", () => {
    expect(decide("edit", "src/ripgrep.ts")).toBe("deny")
    expect(decide("edit", ".council/fixture/test.ts")).toBe("allow")
  })
})

describe("council finished", () => {
  const since = 1_000

  test("waits while the turn has not started or completed", () => {
    expect(finished([], since)).toBeUndefined()
    expect(finished([assistant(500, 600, "old reply")], since)).toBeUndefined()
    expect(finished([assistant(500, 600, "old"), user(1_100)], since)).toBeUndefined()
    expect(finished([user(1_100), assistant(1_200, undefined, "partial")], since)).toBeUndefined()
  })

  test("returns the completed reply of the new turn", () => {
    expect(finished([user(1_100), assistant(1_200, 1_300, "findings")], since)).toEqual({ text: "findings" })
  })

  test("falls back to earlier steps when the last step has no text", () => {
    const items = [
      user(1_100),
      assistant(1_200, 1_250, "my findings", { finish: "tool-calls" }),
      assistant(1_300, 1_400, "", { finish: "stop" }),
    ]
    expect(finished(items, since)).toEqual({ text: "my findings" })
  })

  test("keeps waiting after a completed step that ended in tool calls", () => {
    const items = [user(1_100), assistant(1_200, 1_250, "Let me check the tests.", { finish: "tool-calls" })]
    expect(finished(items, since)).toBeUndefined()
  })

  test("reports a failed turn", () => {
    const error = { name: "UnknownError", data: { message: "rate limited" } } as const
    expect(finished([user(1_100), assistant(1_200, 1_300, "", { error })], since)).toEqual({
      error: "UnknownError: rate limited",
    })
  })
})
