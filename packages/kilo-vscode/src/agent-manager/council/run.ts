import type { KiloClient, Message, Part } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../../kilo-provider-utils"
import { isRunningStatus } from "../../session-status"
import { SNAPSHOT_INITIALIZATION } from "../constants"
import { attribute } from "../prompt-attribution"
import {
  REFORMAT,
  answered,
  cross,
  independent,
  listed,
  merge,
  report,
  reported,
  retry,
  type Report,
  type Target,
} from "./prompts"

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
  /** Give up on one turn after this long. */
  timeout?: number
  /** Treat an idle session that never started its reply as stalled after this long. */
  stall?: number
  /** Wait this long after a failed turn before nudging the member again. */
  cooldown?: number
}

type Outcome = { text: string } | { error: string }

/** Members use the normal agent; their session rules keep the code under review unchanged. */
const MEMBER_AGENT = "code"
/** The chair only merges and reports, so it never needs to edit. */
const CHAIR_AGENT = "ask"
const INTERVAL = 3_000
const TIMEOUT = 45 * 60_000
const STALL = 2 * 60_000
const COOLDOWN = 60_000
/** Nudges after a failed or malformed turn, on top of the first attempt. */
const RETRIES = 2

export async function runCouncil(
  deps: CouncilDeps,
  input: { task: string; members: Member[]; chair: Seat; target?: Target },
) {
  const chair = { ...input.chair, label: "chair" }
  const note = (text: string) => status(deps, chair, text)

  await note(`Round 1: ${input.members.map((member) => member.label).join(", ")} work independently.`)
  const first = await round(deps, input.members, chair, "round 1", {
    prompt: (member) => independent(member.label, input.task, input.target),
    accept: (member, text) => reported(member.label, text),
  })
  const reports = texts(first)
  await note(`Round 1 finished. ${summary(first)}`)
  if (reports.length === 0) {
    deps.error(`Council stopped: no member finished round 1. ${failures(first)}`)
    return
  }

  deps.log("[council] chair merge")
  const merged = await turn(deps, chair, merge(input.task, reports, missing(input.members, reports)), CHAIR_AGENT)
  if ("error" in merged) {
    deps.error(`Council stopped: the chair failed to merge the findings. ${merged.error}`)
    return
  }

  const active = input.members.filter((member) => reports.some((item) => item.label === member.label))
  const examined = listed(merged.text)
  if (!examined) await note("No findings to cross-examine.")
  const second = examined ? await crossExamine(deps, active, chair, merged.text, note) : []
  const answers = texts(second)

  deps.log("[council] chair report")
  const final = await turn(
    deps,
    chair,
    report({
      task: input.task,
      merged: merged.text,
      answers,
      seats: input.members.map((member) => ({ label: member.label, model: name(member.model) })),
      missing: missing(input.members, examined ? answers : reports),
    }),
    CHAIR_AGENT,
  )
  if ("error" in final) {
    deps.error(`Council stopped: the chair failed to write the report. ${final.error}`)
    return
  }
  deps.log("[council] done")
}

/**
 * The finished reply of the turn started at `since`, or undefined while that
 * turn is still going. A completed step that ended in tool calls is not the
 * end of a turn. Messages are oldest first.
 */
export function finished(items: Array<{ info: Message; parts: Part[] }>, since: number): Outcome | undefined {
  const last = items.at(-1)
  if (!last || last.info.role !== "assistant") return undefined
  if (last.info.time.created < since || last.info.time.completed === undefined) return undefined
  if (last.info.error) return { error: describe(last.info.error) }
  if (last.info.finish === "tool-calls") return undefined
  const own = text(last.parts)
  if (own) return { text: own }
  // A turn that ended on a tool step keeps its prose in earlier steps.
  const turn = items
    .filter((item) => item.info.role === "assistant" && item.info.time.created >= since)
    .map((item) => text(item.parts))
    .filter(Boolean)
    .join("\n\n")
  return turn ? { text: turn } : { error: "the reply had no text" }
}

async function crossExamine(
  deps: CouncilDeps,
  members: Member[],
  chair: Member,
  merged: string,
  note: (text: string) => Promise<void>,
) {
  await note(`Cross-examination: ${members.map((member) => member.label).join(", ")} check every finding.`)
  const results = await round(deps, members, chair, "cross-examination", {
    prompt: (member) => cross(member.label, merged),
    accept: (_, text) => answered(text),
  })
  await note(`Cross-examination finished. ${summary(results)}`)
  return results
}

async function round(
  deps: CouncilDeps,
  members: Member[],
  chair: Member,
  stage: string,
  ask: { prompt: (member: Member) => string; accept: (member: Member, text: string) => boolean },
): Promise<Array<{ label: string; outcome: Outcome }>> {
  deps.log(`[council] ${stage}: ${members.length} members`)
  return Promise.all(
    members.map(async (member) => {
      const outcome = await attempt(deps, member, chair, ask.prompt(member), (text) => ask.accept(member, text))
      deps.log(`[council] ${stage} ${member.label}: ${"text" in outcome ? "ok" : `failed: ${outcome.error}`}`)
      return { label: member.label, outcome }
    }),
  )
}

/**
 * One member turn with recovery: a failed turn is nudged after a cooldown
 * (rate limits are the common cause), a malformed reply is asked to finish.
 * A member the user already resumed is waited on instead of nudged.
 */
async function attempt(
  deps: CouncilDeps,
  member: Member,
  chair: Member,
  prompt: string,
  accept: (text: string) => boolean,
): Promise<Outcome> {
  const outcome = await turn(deps, member, prompt, MEMBER_AGENT, chair.session)
  return recover(deps, member, chair, outcome, accept, RETRIES)
}

async function recover(
  deps: CouncilDeps,
  member: Member,
  chair: Member,
  outcome: Outcome,
  accept: (text: string) => boolean,
  tries: number,
): Promise<Outcome> {
  if ("text" in outcome && accept(outcome.text)) return outcome
  if (tries === 0) return "text" in outcome ? { error: "the reply never had the required format" } : outcome
  const reason = "error" in outcome ? outcome.error : "missing the required section"
  deps.log(`[council] ${member.label}: ${reason}; nudging (${tries} left)`)
  await status(deps, chair, `${member.label}: ${reason}. Nudging it to continue.`)
  if ("error" in outcome) await sleep(deps.cooldown ?? COOLDOWN)
  const resumed = await running(deps, member).catch(() => false)
  const next = resumed
    ? await settle(deps, member, Date.now()).catch((err: unknown) => ({ error: getErrorMessage(err) }))
    : await turn(deps, member, "error" in outcome ? retry(reason) : REFORMAT, MEMBER_AGENT, chair.session)
  return recover(deps, member, chair, next, accept, tries - 1)
}

/** Send one prompt and wait for that turn to finish. */
async function turn(deps: CouncilDeps, seat: Seat, prompt: string, agent: string, source?: string): Promise<Outcome> {
  const since = Date.now()
  const sent = await deps
    .client()
    .session.promptAsync(
      {
        sessionID: seat.session,
        directory: seat.dir,
        agent,
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
  const stall = since + (deps.stall ?? STALL)
  while (Date.now() < end) {
    if (!(await running(deps, seat))) {
      const page = await client.session.messages(
        { sessionID: seat.session, directory: seat.dir, limit: 30 },
        { throwOnError: true },
      )
      const done = finished(page.data, since)
      if (done) return done
      // Idle with no reply after the prompt: the model never started.
      if (page.data.at(-1)?.info.role === "user" && Date.now() > stall) return { error: "the model never replied" }
    }
    await sleep(deps.interval ?? INTERVAL)
  }
  return { error: "timed out waiting for a reply" }
}

async function running(deps: CouncilDeps, seat: Seat): Promise<boolean> {
  const { data } = await deps.client().session.status({ directory: seat.dir }, { throwOnError: true })
  return isRunningStatus(data[seat.session]?.type)
}

/** Post a progress line into the chair session without starting a model turn. Never names models. */
async function status(deps: CouncilDeps, chair: Seat, line: string): Promise<void> {
  await deps
    .client()
    .session.promptAsync(
      {
        sessionID: chair.session,
        directory: chair.dir,
        noReply: true,
        parts: [{ type: "text", text: `Council status: ${line}` }],
      },
      { throwOnError: true },
    )
    .catch((err: unknown) => deps.log("[council] status note failed:", getErrorMessage(err)))
}

function texts(results: Array<{ label: string; outcome: Outcome }>): Report[] {
  return results.flatMap((item) => ("text" in item.outcome ? [{ label: item.label, text: item.outcome.text }] : []))
}

function summary(results: Array<{ label: string; outcome: Outcome }>): string {
  return results.map((item) => `${item.label} ${"text" in item.outcome ? "done" : "left out"}`).join(", ") + "."
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
