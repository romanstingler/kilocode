/**
 * Prompts for a model council run. Pure functions — no vscode imports.
 *
 * Members only ever see anonymous labels (A, B, …). Model identities reach
 * the chair in the final report prompt and nowhere else.
 */

export interface Report {
  label: string
  text: string
}

export interface Seat {
  label: string
  model: string
}

const FINDING = [
  "### <label>1 [critical|warning|suggestion] path/to/file.ext:line - short title",
  "Problem: what is wrong",
  "Evidence: the specific code that shows it (quote the line or name the function)",
  "Scenario: a concrete input or state, and the wrong result it causes",
  "Fix: the change you propose",
  "Confidence: high|medium",
].join("\n")

export function labels(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))
}

export function independent(label: string, task: string): string {
  return [
    `You are council member ${label} in a model council. Several models work on the task below independently. Afterwards you will see everyone's findings, without names, and cross-check them.`,
    "",
    "Task from the user:",
    task,
    "",
    "Rules:",
    "- You are read-only. Inspect code by reading and searching files and with read-only git commands (git show, git diff, git log, git status, gh pr diff, gh pr view). Do not try to edit anything.",
    "- Work alone and be thorough. Report every real problem, including ones you are only fairly sure about; mark those `medium`. Skip pure style preferences.",
    "- Before reporting, check the surrounding code: callers, types and tests.",
    "",
    `End your reply with your findings in exactly this shape, numbered ${label}1, ${label}2, …:`,
    "",
    FINDING.replaceAll("<label>", label),
    "",
    'If you find nothing, write "No findings" and say what you checked.',
  ].join("\n")
}

export function merge(task: string, reports: Report[], missing: string[]): string {
  return [
    "You chair a model council. Do not review the code yourself and do not judge whether findings are right.",
    "Your job now is to merge the members' reports into one list of distinct findings.",
    "",
    "Task the members worked on:",
    task,
    "",
    ...absent(missing),
    ...reports.flatMap((report) => [`## Member ${report.label}`, "", report.text, ""]),
    "Produce one list with IDs F1, F2, …:",
    "- Group findings only when they describe the same problem in the same place. When unsure, keep them separate.",
    "- Do not drop, soften or add findings.",
    "- If members proposed different fixes for one finding, keep each fix, labelled by its author.",
    "",
    "Reply with only the list, each finding in this shape:",
    "",
    "### F1 [critical|warning|suggestion] path/to/file.ext:line - short title",
    "Raised by: A, C",
    "Problem: …",
    "Evidence: …",
    "Scenario: …",
    "Fix (A): …",
    "Fix (C): …",
    "",
    'If no member reported anything, reply "No findings".',
  ].join("\n")
}

export function cross(label: string, merged: string): string {
  return [
    `Council member ${label}, cross-examination round.`,
    "",
    `Below are all findings the council raised. Authors are anonymous labels; you are ${label}.`,
    "",
    merged,
    "",
    "For EVERY finding, answer on one line:",
    "F<k>: confirm|dispute|unsure - <evidence>",
    "",
    "Rules:",
    "- Check the code yourself before answering. Do not confirm a finding because others raised it, and do not dispute it because others did.",
    "- dispute needs concrete evidence from the code that the problem does not exist or does not matter. Quote the code.",
    "- confirm needs one line saying what you checked.",
    "- unsure is fine when you cannot verify it.",
    '- For findings you raised: confirm them, or withdraw one with "F<k>: withdraw - <reason>".',
    "",
    `Then list any NEW finding that the others' findings made you notice, in the same shape as before, continuing your own numbering (${label}…). Write "No new findings" if there are none.`,
    "You are still read-only.",
  ].join("\n")
}

export function report(input: {
  task: string
  merged: string
  answers: Report[]
  seats: Seat[]
  missing: string[]
}): string {
  return [
    "You chair a model council. Write the final report from the members' cross-examination answers.",
    "Do not add your own judgment of the code; report what the members found and how they answered.",
    "",
    "Task the members worked on:",
    input.task,
    "",
    `Members (you may reveal these now): ${input.seats.map((seat) => `${seat.label} = ${seat.model}`).join(", ")}`,
    ...absent(input.missing),
    "",
    "Merged findings:",
    "",
    input.merged,
    "",
    "Cross-examination answers:",
    "",
    ...input.answers.flatMap((answer) => [`## Member ${answer.label}`, "", answer.text, ""]),
    "Classify each finding by the members' answers:",
    "- Confirmed: confirmed by a majority of the members who answered, including at least one member who is not its author, and nobody disputes it.",
    "- Disputed: at least one member disputes it with evidence.",
    "- Unverified: only its author supports it, or it was raised as new during cross-examination and so was never cross-checked.",
    "- Withdrawn: its author withdrew it.",
    "",
    "Write the report in this format:",
    "",
    "## Council report",
    "",
    "Members: A = <model>, B = <model>, …",
    "",
    "### Summary",
    "<one paragraph>",
    "",
    "### Findings",
    "| # | Status | Severity | File:Line | Issue | Answers |",
    "|---|---|---|---|---|---|",
    "| F1 | Confirmed | critical | `src/x.ts:42` | <title> | A✓* B✓ C✓ |",
    "",
    "### Details",
    "<for each confirmed, disputed and unverified finding: the problem, the scenario, the fix or competing fixes, and for disputed findings the strongest argument on each side>",
    "",
    "### Withdrawn",
    "<one line per withdrawn finding, with the reason>",
    "",
    "In the Answers column use ✓ confirm, ✗ dispute, ? unsure and – withdrawn, and mark the author with *.",
  ].join("\n")
}

function absent(missing: string[]): string[] {
  if (missing.length === 0) return []
  return [`Members ${missing.join(", ")} failed or did not answer and are left out.`, ""]
}
