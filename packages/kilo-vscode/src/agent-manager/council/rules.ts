import type { PermissionRuleset } from "@kilocode/sdk/v2/client"

/**
 * Session permissions for council members, layered over the normal agent.
 * Session rules are evaluated after the agent's and the last match wins, so
 * every allow here must be followed by the chaining guards below: otherwise
 * `git show x; anything` would match `git show *`.
 */

/** Scratch folder, inside the member's own worktree, where members may write. */
export const SCRATCH = ".council"

const READ = [
  "git show *",
  "git diff *",
  "git log *",
  "git status *",
  "git blame *",
  "git rev-parse *",
  "git ls-files *",
  "git cat-file *",
  "gh pr view *",
  "gh pr diff *",
]

/** Command chaining, substitution, redirection and file output go back to the user. */
const CHAIN = ["*\n*", "*|*", "*;*", "*&*", "*>*", "*<(*", "*$(*", "*`*", "*--output*"]

export const MEMBER_RULES: PermissionRuleset = [
  ...READ.map((pattern) => ({ permission: "bash", pattern, action: "allow" as const })),
  ...CHAIN.map((pattern) => ({ permission: "bash", pattern, action: "ask" as const })),
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "edit", pattern: `${SCRATCH}/*`, action: "allow" },
]
