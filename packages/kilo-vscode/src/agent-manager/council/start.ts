import { getErrorMessage } from "../../kilo-provider-utils"
import { PLATFORM } from "../constants"
import type { CreatedVersion } from "../multi-version"
import type { ProjectContext } from "../project/context"
import type { MultiVersionHost } from "../provider-multi-version"
import type { AgentManagerInMessage } from "../types"
import { labels } from "./prompts"
import { runCouncil, type Model } from "./run"

const TITLE_MAX = 60

type Request = Extract<AgentManagerInMessage, { type: "agentManager.createMultiVersion" }>

/**
 * Check a request before any worktree is created. True for non-council
 * requests; a council problem is reported to the user.
 */
export function councilReady(host: Pick<MultiVersionHost, "error">, msg: Request): boolean {
  if (!msg.council) return true
  if (!msg.text?.trim()) {
    host.error("A council needs a task: describe what the members should work on.")
    return false
  }
  if ((msg.modelAllocations ?? []).reduce((sum, item) => sum + item.count, 0) < 2) {
    host.error("A council needs at least two members.")
    return false
  }
  return true
}

/** For a council request, run the council on the created member worktrees in the background. */
export function seatCouncil(
  ctx: ProjectContext,
  host: MultiVersionHost,
  msg: Request,
  created: CreatedVersion[],
  models: Array<Model | undefined>,
) {
  const task = msg.text?.trim()
  if (!msg.council || !task || created.length === 0) return
  void startCouncil(ctx, host, { task, created, models, chair: msg.council.chair }).catch((error: unknown) =>
    host.error(`Council stopped: ${getErrorMessage(error)}`),
  )
}

/**
 * Seat a council on freshly created member worktrees: label the worktrees,
 * open the chair as a local session, then run the council.
 */
async function startCouncil(
  ctx: ProjectContext,
  host: MultiVersionHost,
  input: {
    task: string
    created: CreatedVersion[]
    models: Array<Model | undefined>
    chair: Model
  },
): Promise<void> {
  const created = [...input.created].sort((a, b) => a.versionIndex - b.versionIndex)
  const seats = created.flatMap((entry) => {
    const model = input.models[entry.versionIndex]
    return model ? [{ entry, model }] : []
  })
  if (seats.length < 2) {
    host.error(`A council needs at least two members, but only ${seats.length} could be started.`)
    return
  }

  const state = ctx.stateManager()
  const names = labels(seats.length)
  const members = seats.map((seat, index) => {
    const label = names[index]!
    // Council prompts must not rename the member worktrees.
    state.clearAutoName(seat.entry.worktreeId)
    state.updateWorktreeLabel(seat.entry.worktreeId, `Council ${label}`)
    return { label, session: seat.entry.sessionId, dir: seat.entry.path, model: seat.model }
  })
  host.push()

  const client = host.client()
  const chair = await client.session
    .create(
      {
        directory: ctx.root,
        platform: PLATFORM,
        metadata: await host.metadata(client, ctx.root),
        title: `Council: ${input.task.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX)}`,
      },
      { throwOnError: true },
    )
    .then(
      (result) => result.data,
      (err: unknown) => {
        host.error(`Council stopped: could not open the chair session. ${getErrorMessage(err)}`)
        return undefined
      },
    )
  if (!chair) return
  state.addSession(chair.id, null)
  host.push()
  host.sessions.register(chair)

  host.log(`[council] seated ${members.map((member) => member.label).join(", ")}; chair=${chair.id}`)
  await runCouncil(
    { client: host.client, log: host.log, error: host.error },
    { task: input.task, members, chair: { session: chair.id, dir: ctx.root, model: input.chair } },
  )
}
