import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@kilocode/sdk/v2/client"
import { cross, independent, labels, merge, report } from "../../src/agent-manager/council/prompts"
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
    const items = [user(1_100), assistant(1_200, 1_250, "my findings"), assistant(1_300, 1_400, "")]
    expect(finished(items, since)).toEqual({ text: "my findings" })
  })

  test("reports a failed turn", () => {
    const error = { name: "UnknownError", data: { message: "rate limited" } } as const
    expect(finished([user(1_100), assistant(1_200, 1_300, "", { error })], since)).toEqual({
      error: "UnknownError: rate limited",
    })
  })
})
