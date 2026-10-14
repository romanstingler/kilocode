import { getErrorMessage } from "../../kilo-provider-utils"
import { exec } from "../../util/process"
import { PLATFORM } from "../constants"
import type { CreatedVersion } from "../multi-version"
import type { ProjectContext } from "../project/context"
import type { MultiVersionHost } from "../provider-multi-version"
import type { AgentManagerInMessage } from "../types"
import { labels, type Target } from "./prompts"
import { MEMBER_RULES } from "./rules"
import { runCouncil, type Model } from "./run"

const TITLE_MAX = 60

type Request = Extract<AgentManagerInMessage, { type: "agentManager.createMultiVersion" }>

/** What a request needs before its worktrees are created; `ref` is the commit they start from. */
export interface Prepared {
  ref?: string
  target?: Target
}

/**
 * Check a request before any worktree is created and resolve its review
 * target to a commit. Undefined means stop: the problem was reported to the
 * user. Requests without a council pass through.
 */
export async function prepareCouncil(
  ctx: ProjectContext,
  host: Pick<MultiVersionHost, "error">,
  msg: Request,
): Promise<Prepared | undefined> {
  if (!msg.council) return {}
  if (!msg.text?.trim()) {
    host.error("A council needs a task: describe what the members should work on.")
    return undefined
  }
  if ((msg.modelAllocations ?? []).reduce((sum, item) => sum + item.count, 0) < 2) {
    host.error("A council needs at least two members.")
    return undefined
  }
  const name = msg.council.target?.trim()
  if (!name) return {}
  const commit = await exec("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`], {
    cwd: ctx.root,
  }).then(
    (result) => result.stdout.trim(),
    () => "",
  )
  if (!commit) {
    host.error(`Council target "${name}" is not a commit or branch in this repository.`)
    return undefined
  }
  return { ref: commit, target: { name, commit: commit.slice(0, 12) } }
}

/** For a council request, run the council on the created member worktrees in the background. */
export function seatCouncil(
  ctx: ProjectContext,
  host: MultiVersionHost,
  msg: Request,
  created: CreatedVersion[],
  models: Array<Model | undefined>,
  prepared: Prepared,
) {
  const task = msg.text?.trim()
  if (!msg.council || !task || created.length === 0) return
  void startCouncil(ctx, host, {
    task,
    created,
    models,
    chair: msg.council.chair,
    target: prepared.target,
  }).catch((error: unknown) => host.error(`Council stopped: ${getErrorMessage(error)}`))
}

/**
 * Seat a council on freshly created member worktrees: label the worktrees,
 * apply the member permissions, open the chair as a local session, then run
 * the council.
 */
async function startCouncil(
  ctx: ProjectContext,
  host: MultiVersionHost,
  input: {
    task: string
    created: CreatedVersion[]
    models: Array<Model | undefined>
    chair: Model
    target?: Target
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
  // Without these rules a member could change the code under review, so a failure stops the council.
  await Promise.all(
    members.map((member) =>
      client.session.update(
        { sessionID: member.session, directory: member.dir, permission: MEMBER_RULES },
        { throwOnError: true },
      ),
    ),
  )

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

  host.log(
    `[council] seated ${members.map((member) => member.label).join(", ")}; chair=${chair.id}` +
      (input.target ? `; target=${input.target.name}@${input.target.commit}` : ""),
  )
  await runCouncil(
    { client: host.client, log: host.log, error: host.error },
    {
      task: input.task,
      members,
      chair: { session: chair.id, dir: ctx.root, model: input.chair },
      target: input.target,
    },
  )
}
