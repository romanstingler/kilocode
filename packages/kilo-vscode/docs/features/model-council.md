# Model Council

**Status:** In progress, step 3 of the iteration plan below. Developed on `romanstingler/kilocode`, branch `llm-council`.

Several models work on the same task independently, check each other's work in rounds, and converge on one result. Disagreements that survive the rounds are reported, not hidden. The council then asks the user whether to build the result.

## Use cases

| Mode | Members produce | Council result |
|---|---|---|
| review | Findings in a change (uncommitted, staged, branch, commit, PR) | Verified findings, each with a fix |
| plan | A design for a feature | One plan, with open disagreements listed |
| fix | A diagnosis and fix for a bug, or an approach for a refactor | Agreed cause and fix approach |

All modes share one protocol. Only the round 1 task and the result format differ. Step 1 implements `review` only.

## Protocol

1. **Independent work.** Each member works read-only on its own model and can't see the others. It reports numbered items with evidence and a proposed fix. In review mode it also reports medium-confidence items, because the rounds filter them.
2. **Merge.** The chair groups duplicates into one list (F1, F2, …). Authors are shown as anonymous labels (A, B, C), never model names.
3. **Cross-examination.** Each member answers every item: confirm, dispute or unsure, with evidence from the code. It may withdraw its own items and add new ones that the others' items made it notice.
4. **Stop** when a round changes no answers and adds no items, or after the maximum number of rounds (default 3).
5. **Report.** Items grouped as confirmed, disputed (both sides shown), unverified and withdrawn. Model identities are revealed here.
6. **Decision.** The chair asks the user: build all confirmed items, choose items, or nothing.
7. **Build.** A builder implements the chosen items in its own worktree. One builder by default; competing builders (one worktree per model, like Compare Models) as an option.
8. **Verify the build.** The council reviews the builder's worktree with the same rounds. The user brings the result into their branch with Agent Manager's Apply.

### Rules against herding

Models tend to agree with their peers without checking. Because the goal is to miss nothing:

- An item is dropped only with a concrete refutation from the code, never because others disagree.
- Changing an answer requires new evidence.
- Members never learn which model wrote what.
- The report keeps unresolved disagreements visible instead of forcing agreement.

## Building blocks

| Need | Existing piece |
|---|---|
| Visible sessions on chosen models | `agent_manager` tool, `start` with `mode: "local"` or `"worktree"` (`packages/opencode/src/kilocode/tool/agent-manager.ts`) |
| Messages between chair and members | `agent_manager` `prompt` plus `replyTo`; the extension wraps requests and replies (`peerPrompt`, `peerReply` in `src/agent-manager/orchestration-bridge.ts`) |
| Model lookup | `agent_manager_models` tool |
| Review procedure and finding format | `/review` (`packages/opencode/src/kilocode/review/review.txt`) |
| Asking the user | `question` tool; plan mode's "Ready to implement?" handoff (`packages/opencode/src/kilocode/plan-followup.ts`) |
| Parallel worktrees on different models | Compare Models / multi-version (`src/agent-manager/multi-version.ts`, at most 4) |
| Bringing a worktree's changes home | Agent Manager Apply (per-file selection, conflict check) |
| Copying uncommitted changes into a worktree | `src/agent-manager/git-transfer.ts` |

Kilo's `AGENTS.md` asks to avoid changes to code shared with upstream opencode. The council should live in Kilo-only code: `packages/kilo-vscode/` and `packages/opencode/src/kilocode/`.

## Iterations

### Step 0: setup (done)

- Fork `romanstingler/kilocode` synced with `Kilo-Org/kilocode` `main`.
- Worktree `/srv/opensource/kilocode-council` on branch `llm-council`.
- Dev window: `bun run extension:isolated` in `packages/kilo-vscode`. It builds the extension, then opens the repo root as the workspace.
- Everyday install: `KILO_SKIP_BUNDLED_BWRAP=1 bun run snapshot:install` in `packages/kilo-vscode`. The flag skips the Zig-built sandbox helper; the system `/usr/bin/bwrap` is used instead. Turn off auto-update for Kilo Code afterwards, because the snapshot version sorts below the release.

### Step 1: review council as a slash command (rejected)

A `/council` command whose chair session drove the members through the `agent_manager` tool. First run, on commit `e48c9785c7` with two free models:

- **UX:** typing a slash command with model names is not acceptable. The council must be started and followed in the Agent Manager UI.
- **Mechanics failed:** in `local` mode the tool ignores the task `name` (`tool-start.ts` creates the session without a title), so the chair couldn't match sessions to members. One member was stuck in provider retry (free model). The chair then called an `agent_manager` action that doesn't exist.
- **Lesson:** the extension host already has what an LLM chair lacked: direct session creation with a model and agent, session status, and message reads. Orchestration belongs in host code. The command file was removed.

### Step 2: council in the New Worktree dialog (done)

**UI.** A **Council** button next to Compare Models. It opens the same model picker for the members (2 to 4) and keeps the prompt's model chip visible: that model chairs the council. The prompt box holds the task, for example `review commit e48c9785c7`.

**Flow.** Code in `src/agent-manager/council/` drives every step; no model decides what happens next.

1. The members are created through the Compare Models path, one worktree each, shown as one group. Their worktrees are relabelled `Council A`, `Council B`, … and auto-naming is turned off for them.
2. The chair opens as a local session titled `Council: <task>`.
3. Round 1: each member gets the task with the council rules, in its own session. (Step 2 used the read-only `ask` agent; step 3 replaced it.)
4. The host polls session status and reads each member's finished reply.
5. The chair merges the reports into one list (F1, F2, …) with anonymous authors.
6. Cross-examination: each member answers every finding in its own session (confirm, dispute, unsure, withdraw) and may add new ones.
7. The chair writes the report, revealing which model was which.

Members that fail are left out and named in the merge and report prompts. A failure of the chair, or of every member in round 1, stops the run with an error message.

**Not yet:** more than one cross-examination round and the stopping rule, a council progress view, the build decision, and the plan and fix modes. Attachments in the prompt are not passed to the members. Members work on committed code: uncommitted changes in the main checkout are not copied into their worktrees.

**Code.** `council/prompts.ts` (prompt builders), `council/run.ts` (orchestration and turn completion), `council/start.ts` (validation, worktree labels, chair session), wired in `provider-multi-version.ts`. The dialog sends `council: { chair }` on the existing `agentManager.createMultiVersion` message, so `AgentManagerProvider.ts` (at its line cap) is unchanged. Tests: `tests/unit/council.test.ts`.

**Outcome (2026-10-14).** Run on commit `e48c9785c7` with four small free models. The report confirmed two cosmetic findings, one of them a false positive ("avoid `.at()`", which the project's AGENTS.md requires), and lost the one real problem: member C found that `find` and `grep` still bypass `.gitignore`, which the follow-up commit `17448f5c50` fixes. Causes:

- C hit a provider rate limit (429); the turn ended with an error and the council dropped C at once. The user resumed C, but nothing was watching it.
- D's model never replied; the council moved on without D, and the per-member reason was not logged.
- Member worktrees started from the current branch, which already contained the follow-up fix, so three members reviewed newer code than the commit.
- The read-only `ask` agent blocked C's attempt to verify its finding with a small fixture; C spent about 20 minutes fighting the sandbox.
- Members confirmed a finding that contradicts the project's conventions.
- The user could not see that C and D had been left out.

### Step 3: reliability (current)

- **Retry instead of drop.** A failed turn is nudged with "continue" after a 60 s cooldown, up to twice. A member whose model never starts replying counts as stalled after 2 minutes. A reply without the required section is asked to finish once per remaining try. A member the user resumed is waited on instead of nudged. Each member's outcome is logged.
- **End of turn.** A completed step that ended in tool calls no longer counts as the end of a turn.
- **Review target.** In Council mode the dialog has a target field (commit or branch). The host resolves it with `git rev-parse` before creating anything, and member worktrees start at that commit (`baseRef`, as Continue in Worktree uses).
- **Members can verify.** Members run the normal `code` agent. A session ruleset (`council/rules.ts`) allows read-only git and `gh pr view/diff` without asking, sends chained commands (pipes, `;`, `&&`, redirects, `--output`) back to the user, and allows edits only under `.council/` in the member's worktree. Session rules are evaluated after the agent's and the last match wins, so the chaining guards come after the allows. Running tests asks the user.
- **Conventions.** Prompts tell members to judge findings against the project's AGENTS.md, and to dispute a finding that contradicts it.
- **Progress.** Status notes go into the chair session (`noReply` prompts, no model turn): round start and end, and each nudge. Notes never name models.
- **No findings, no cross-examination.** If the merged list is empty, the council goes straight to the report.

Not yet: PR targets, and copying uncommitted changes into member worktrees.

### Step 4: decision and build

The chair asks with the `question` tool: build all confirmed items, choose items, or nothing. On build, one `worktree` session implements the agreed fixes. When it's done, the council reviews that worktree with the same rounds. Open questions: single or competing builders by default; one decision for everything or per item.

### Step 5: multiple rounds and a progress view

Repeat cross-examination until no answer changes and nothing new is added, up to a maximum. Show council progress in the Agent Manager instead of chair notes.

### Step 6: plan and fix modes

Round 1 tasks and result formats for feature planning and for bug or refactor work, chosen in the dialog.

### Step 7: council view

A findings view in the Agent Manager: each finding with every member's answer, and the decision.

### Step 8: upstream

Changeset, docs, and a PR to `Kilo-Org/kilocode`.

## History

The first design was an opencode core service with a web app UI. It was dropped: the Kilo extension runs its own bundled CLI, so a core service added to opencode wouldn't reach it, and the Agent Manager already has the parallel-session, worktree and apply pieces.
