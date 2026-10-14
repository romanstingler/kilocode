import type { KiloClient, Message, Part } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../../kilo-provider-utils"
import { isRunningStatus } from "../../session-status"
import { SNAPSHOT_INITIALIZATION } from "../constants"
import { attribute } from "../prompt-attribution"
import { cross, independent, merge, report, type Report } from "./prompts"

/**
 * Model council orchestration: independent work, a chair merge, one
 * cross-examination round, and a chair report. The host drives every step;
 * no model decides what happens next. Vscode-free.
 */

export interface Model {
  providerID: string
  modelID: string
  variant?: string
}

export interface Seat {
  session: string
  dir: string
  model: Model
}

export interface Member extends Seat {
  label: string
}

export interface CouncilDeps {
  client: () => KiloClient
  log: (...args: unknown[]) => void
  error: (message: string) => void
  /** Delay between status polls. */
  interval?: number
  /** Give up on one session after this long. */
  timeout?: number
}

type Outcome = { text: string } | { error: string }

/** Members cannot edit: the `ask` agent denies edits and allows only read-only shell commands. */
const AGENT = "ask"
const INTERVAL = 3_000
const TIMEOUT = 45 * 60_000

export async function runCouncil(deps: CouncilDeps, input: { task: string; members: Member[]; chair: Seat }) {
  deps.log(`[council] round 1: ${input.members.length} members`)
  const first = await round(deps, input.members, input.chair.session, (member) => independent(member.label, input.task))
  const reports = texts(first)
  if (reports.length === 0) {
    deps.error(`Council stopped: no member finished round 1. ${failures(first)}`)
    return
  }

  deps.log("[council] chair merge")
  const merged = await turn(deps, input.chair, merge(input.task, reports, missing(input.members, reports)))
  if ("error" in merged) {
    deps.error(`Council stopped: the chair failed to merge the findings. ${merged.error}`)
    return
  }

  const active = input.members.filter((member) => reports.some((item) => item.label === member.label))
  deps.log(`[council] cross-examination: ${active.length} members`)
  const second = await round(deps, active, input.chair.session, (member) => cross(member.label, merged.text))
  const answers = texts(second)

  deps.log("[council] chair report")
  const final = await turn(
    deps,
    input.chair,
    report({
      task: input.task,
      merged: merged.text,
      answers,
      seats: input.members.map((member) => ({ label: member.label, model: name(member.model) })),
      missing: missing(input.members, answers),
    }),
  )
  if ("error" in final) {
    deps.error(`Council stopped: the chair failed to write the report. ${final.error}`)
    return
  }
  deps.log("[council] done")
}

/**
 * The finished reply of the turn started at `since`, or undefined while that
 * turn has not completed. Messages are oldest first.
 */
export function finished(items: Array<{ info: Message; parts: Part[] }>, since: number): Outcome | undefined {
  const last = items.at(-1)
  if (!last || last.info.role !== "assistant") return undefined
  if (last.info.time.created < since || last.info.time.completed === undefined) return undefined
  if (last.info.error) return { error: describe(last.info.error) }
  const own = text(last.parts)
  if (own) return { text: own }
  // A turn that ended on a tool step keeps its prose in earlier steps.
  const turn = items
    .filter((item) => item.info.role === "assistant" && item.info.time.created >= since)
    .map((item) => text(item.parts))
    .filter(Boolean)
    .join("\n\n")
  return turn ? { text: turn } : { error: "The reply had no text." }
}

async function round(
  deps: CouncilDeps,
  members: Member[],
  source: string,
  prompt: (member: Member) => string,
): Promise<Array<{ label: string; outcome: Outcome }>> {
  return Promise.all(
    members.map(async (member) => ({
      label: member.label,
      outcome: await turn(deps, member, prompt(member), source),
    })),
  )
}

/** Send one prompt and wait for that turn to finish. */
async function turn(deps: CouncilDeps, seat: Seat, prompt: string, source?: string): Promise<Outcome> {
  const client = deps.client()
  const since = Date.now()
  const sent = await client.session
    .promptAsync(
      {
        sessionID: seat.session,
        directory: seat.dir,
        agent: AGENT,
        model: { providerID: seat.model.providerID, modelID: seat.model.modelID },
        variant: seat.model.variant,
        parts: [{ type: "text", text: attribute(prompt, source) }],
        snapshotInitialization: SNAPSHOT_INITIALIZATION,
      },
      { throwOnError: true },
    )
    .then(
      () => undefined,
      (err: unknown) => ({ error: getErrorMessage(err) }),
    )
  if (sent) return sent
  return settle(deps, seat, since).catch((err: unknown) => ({ error: getErrorMessage(err) }))
}

async function settle(deps: CouncilDeps, seat: Seat, since: number): Promise<Outcome> {
  const client = deps.client()
  const end = since + (deps.timeout ?? TIMEOUT)
  while (Date.now() < end) {
    const { data } = await client.session.status({ directory: seat.dir }, { throwOnError: true })
    if (!isRunningStatus(data[seat.session]?.type)) {
      const page = await client.session.messages(
        { sessionID: seat.session, directory: seat.dir, limit: 30 },
        { throwOnError: true },
      )
      const done = finished(page.data, since)
      if (done) return done
    }
    await sleep(deps.interval ?? INTERVAL)
  }
  return { error: "Timed out waiting for a reply." }
}

function texts(results: Array<{ label: string; outcome: Outcome }>): Report[] {
  return results.flatMap((item) => ("text" in item.outcome ? [{ label: item.label, text: item.outcome.text }] : []))
}

function failures(results: Array<{ label: string; outcome: Outcome }>): string {
  return results.flatMap((item) => ("error" in item.outcome ? [`${item.label}: ${item.outcome.error}`] : [])).join("; ")
}

function missing(members: Member[], reports: Report[]): string[] {
  return members.filter((member) => !reports.some((item) => item.label === member.label)).map((member) => member.label)
}

function text(parts: Part[]): string {
  return parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n\n")
    .trim()
}

function name(model: Model): string {
  const base = `${model.providerID}/${model.modelID}`
  return model.variant ? `${base} (${model.variant})` : base
}

function describe(error: NonNullable<Extract<Message, { role: "assistant" }>["error"]>): string {
  const data = error.data as { message?: unknown }
  return typeof data.message === "string" ? `${error.name}: ${data.message}` : error.name
}

function sleep(ms: number): Promise<void> {
  const wait = Promise.withResolvers<void>()
  setTimeout(wait.resolve, ms)
  return wait.promise
}
