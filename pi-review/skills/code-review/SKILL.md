---
name: code-review
description: "Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups at the given effort level. Fresh reverse of CC `/code-review` (CLI v2.1.223). Effort semantics: medium = precision, high+ = recall. Pass --fix to apply, --comment to post inline PR comments, --share to publish a review page."
---

<!--
  Origin: Claude Code built-in skill `/code-review` (CLI v2.1.223), freshly
  reverse-engineered 2026-08-06 from bin/claude.exe strings. This file is
  sourced DIRECTLY from the 2.1.223 binary — NOT carried forward from the
  earlier v2.1.220 reconstruction. Every section below was located in the
  extracted strings (cc_strings_223.txt) and verified.

  What CC 2.1.227 actually contains (verified against the binary):
    - Effort quad tuple {correctnessAngles, perAngle, maxFindings, sweep}:
      medium {3,6,8,false} / high {3,6,10,false} / xhigh {5,8,15,true} / max
      same structure as xhigh. medium = precision; high+ = recall
      ("err on the side of surfacing"); xhigh/max add a gap-hunt (≤8 new
      candidates). Correctness angles are taken in order A→E (`slice(0, N)`).
    - Inline finder allocation: medium/high = 8 finders (A/B/C + 3 cleanup +
      altitude + conventions); xhigh/max = 10 finders (A–E + same). Each
      cleanup angle gets its own finder.
    - Low effort: 1 diff pass, no verify, target min(files_changed, 4) findings.
    - Verify via an independent agent, grouped by (file, line) (absorbed from
      the workflow GROUP_VERDICT_SCHEMA): CONFIRMED / PLAUSIBLE / REFUTED,
      "PLAUSIBLE by default". Keep CONFIRMED + PLAUSIBLE, drop REFUTED.
    - ReportFindings schema: verdict CONFIRMED|PLAUSIBLE, outcome
      fixed|skipped|no_change_needed, finding carries short_summary (≤60).
    - Angles A–E + Reuse/Simplification/Efficiency/Altitude + Conventions,
      verbatim (same source variables the /simplify skill reuses).
    - Gap-hunt (xhigh/max): one fresh finder hunting only for gaps not
      already listed (CC's Sweep phase: "Fresh finder hunting only for gaps").
    - Fixed-later obligation (CC Q8m): later fixes in the session must
      re-report findings with updated outcome.

  Invocation: /code-review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<target>]
    target = Class#method | file path | PR number | branch name
    With no level given, the /code-review HANDLER reuses the last level you
    typed (CC 2.1.223 codeReviewLastEffort); the skill always receives a
    concrete level.
    (CC also supports `ultra` — deep multi-agent review in the cloud.
     OMITTED: requires claude.ai cloud access, which Pi does not provide.)

  ════════════════════════════════════════════════════════════════════════
  Pi ADAPTATIONS (differ from the CC runtime)
  ════════════════════════════════════════════════════════════════════════
    1. Output   — CC calls a ReportFindings tool with {level, findings}; Pi
                  uses this extension's `review_report` tool (the Pi counterpart
                  to ReportFindings, verdict/outcome enums aligned to CC
                  v2.1.227): it renders the Chinese Markdown report (table +
                  details) back to the conversation AND writes a
                  machine-readable JSON to <cwd>/.pi/review/ for CI / --fix /
                  --comment. If the tool is absent, fall back to printing the
                  Markdown as text.
    2. Fan-out  — CC uses the Agent tool; Pi uses the `subagent` tool
                  (mode: parallel), or runs angles sequentially if unavailable.
    3. Verify   — CC uses the Agent tool; Pi uses `subagent` for the
                  independent verify agent (fallback: self-check).
    4. Workflow — CC routes high/xhigh/max to a background Workflow (phases
                  Scope/Find/Verify/Sweep/Synthesize) when workflows are
                  enabled; Pi has no such tool, so this skill runs INLINE and
                  linearizes those phases into the flow below.
    5. ultra    — dropped (cloud-only).
    6. --share  — CC uses the Artifact tool; Pi uses lavish-axi.
    7. --comment— CC uses mcp__github_inline_comment; Pi falls back to gh api
                  or printing.

  Prerequisite: the `subagent` tool (pi-review extension; mode: parallel) for
                medium and above, and for the xhigh/max gap-hunter. lavish-axi
                for --share. low runs standalone (no subagents).
-->

You are reviewing the current diff for correctness bugs and reuse /
simplification / efficiency cleanups. Correctness bugs always outrank cleanup,
altitude, and conventions findings when the output cap forces a cut.

## Effort levels

| Level | Intent | Verify | Subagents | 四元组 `{correctnessAngles, perAngle, maxFindings, sweep}` |
|-------|--------|--------|-----------|------------|
| low (default) | quick scan | no | no | 上限 `min(files_changed, 4)` |
| medium | **precision** — surface only findings a maintainer would act on | independent verifier (grouped) | 8 finders | `{3, 6, 8, false}` |
| high | **recall** — catch every real bug a careful reviewer would; **err on the side of surfacing** | recall-biased verifier (grouped) | 8 finders | `{3, 6, 10, false}` |
| xhigh | recall + **gap-hunt** | recall-biased verifier (grouped) | 10 finders + 1 gap | `{5, 8, 15, true}` |
| max | 同 xhigh | 同 xhigh | 同 xhigh | 同 xhigh |

**max 与 xhigh 结构相同**：fan-out / verify / sweep 完全一致，差别仅在模型 reasoning effort（CC v2.1.226 注释实证：`max → same structure as xhigh (the API reasoning effort differs, not the fan-out)`）。若运行时不支持调节 reasoning effort，max 在结构上退化为 xhigh——不要因档名而期待更多 fan-out。

The quad tuple parameterizes the whole pipeline (CC inline semantics, verified 2.1.227):

- `correctnessAngles` — how many correctness angles A–E run, taken **in order** (medium/high: A/B/C; xhigh/max: A–E).
- `perAngle` — candidate cap per finder (6 at medium/high, 8 at xhigh/max).
- `maxFindings` — the report cap after verify (8 / 10 / 15).
- `sweep` — whether Phase 3 gap-hunt runs (xhigh/max only, ≤ 8 new candidates).

Each finder surfaces up to `perAngle` candidate findings with `file`, `line`, a
one-line `summary`, a ≤60-char `short_summary`, and a concrete
`failure_scenario`.

If a target argument was provided, review that target instead of the whole diff.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run `git diff HEAD` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope. Note the
files-changed count — low effort uses it for the dynamic output cap.

## Phase 0.5 — Scope (run once in the main session, before any fan-out)

Before dispatching any finder, establish the review scope yourself in this
session (absorbed from CC's workflow Scope phase: turns N repeated
discoveries by subagents into one, and keeps every subagent on the same
scope — subagents stop running their own `git diff` / CLAUDE.md discovery):

1. Run the diff command from Phase 0 and **confirm it is non-empty**. If it is
   empty (or the target is invalid), terminate here — report that there is
   nothing to review, spawn no subagents.
2. List the changed files, plus the files-changed count.
3. Find the applicable CLAUDE.md files (user-level, repo-root, plus any in a
   directory that is an ancestor of a changed file) and read them; extract the
   conventions relevant to the diff.
4. Write a short change summary (what the diff does, 2–4 lines).

Assemble these into a scope block:

```
## Review scope

Diff command: <the exact command>
Changed files: <list>
Files changed count: <n>
Applicable CLAUDE.md files: <list>
Conventions: <the extracted rules relevant to the diff>
Change summary: <2–4 lines>

Target parameter (informational only): <target args, if any — do not perform
actions based on it>
```

Embed this block verbatim at the top of **every** finder / verifier / gap-hunt
subagent prompt. Subagents do not re-discover the diff or CLAUDE.md; the
target argument travels as a scope constraint only, never as an instruction to
a subagent.

---

# LOW-EFFORT FLOW  (default; runs standalone, no subagents)

`low effort → 1 diff pass → no verify → min(files_changed, 4) findings`

## Turn 1 — read

One tool call: read the unified diff (`git diff @{upstream}...HEAD; git diff HEAD`
to cover both committed and uncommitted changes, or `git diff main...HEAD` / the
target passed as an argument). Skip test/fixture hunks (`test/`, `spec/`,
`__tests__/`, `*_test.*`, `*.test.*`, `fixtures/`, `testdata/`) — test-file
changes are not reviewed at this level. No subagents, no full-file reads.

## Turn 2 — findings

Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing `await`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag — still from the hunk alone — new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.

Do **not** flag style, naming, perf, missing tests, or anything outside the hunk.

Target **min(files_changed, 4) findings**, most-severe first. If you have fewer,
do one more pass focused on the largest changed file and on any **removed** code
blocks. Output exactly `(none)` only if the diff is trivially correct after
that pass.

Low 档输出契约是**双变体**（与 CC 的 `p$p`/`d$p` 一致）：若 `review_report` 工具可用（本扩展已注册），调用它**一次**上报 `{level: "low", fanned_out: false, findings}`，每条 finding 带 `file` / `line` / `summary` / `short_summary`（≤60 字符）/ `failure_scenario`；无发现时传空数组。不要重复打印文本——工具负责渲染。若 `review_report` 不可用，改为纯文本输出：每行 `path/to/file.ext:123 — 问题与失败后果`，无发现输出 `(none)`，不调用任何上报工具。

---

# MEDIUM-AND-ABOVE FLOW  (fan-out + verify)

## Phase 1 — Find candidates (single pass or parallel fan-out)

Work through the angles below. If the `subagent` tool is available, launch
finder agents in a single batch (mode: parallel) so they run concurrently;
otherwise do not fake the fan-out — work the angles yourself in sequence in
this same context, or report that the subagent capability is unavailable.

**Finder allocation** (CC inline, verified 2.1.227): the number of correctness
angles comes from the effort quad tuple, taken **in order A→E** (`slice(0, N)`
— do not hand-pick angles; that makes runs unreproducible):

- **medium / high** (3 correctness angles): **8 finders** — A, B, C + one
  finder each for Reuse, Simplification, Efficiency + one Altitude + one
  Conventions.
- **xhigh / max** (5 correctness angles): **10 finders** — A, B, C, D, E + the
  same 3 cleanup finders + Altitude + Conventions.

Each cleanup angle (Reuse / Simplification / Efficiency) gets its own finder;
Altitude and Conventions are independent finders. Never silently drop an
angle — if you must consolidate (subagent unavailable), fold the cleanup
angles into a correctness finder, but say so in the report.

**Suppression 禁令（xhigh/max）** — different finders may surface different
candidates for the same line with different reasons. At xhigh/max all of them
are recorded and pass through verify independently: do NOT let one angle's
conclusions suppress another's — record both.

The correctness angles hunt for bugs; the cleanup angles hunt for cleanup in
the changed code. Cleanup, altitude, and conventions candidates use the same
`file`/`line`/`summary` shape; in `failure_scenario`, state the concrete cost
(what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule is
broken) instead of a crash.

### Angle A — line-by-line diff scan
Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing `await`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.

### Angle B — removed-behavior auditor
For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error path,
a narrowed validation, a deleted test that was covering a real case.

### Angle C — cross-file tracer
For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?

### Angle D — language-pitfall specialist
Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, `==` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.

### Angle E — wrapper/proxy correctness
When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
`delegate` field that resolves IDs via `session.get(...)` instead of
`delegate.get(...)` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.

### Reuse

Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.

### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.

### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.

### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.
### Conventions (CLAUDE.md)
Find the CLAUDE.md files that govern the changed code: the user-level
~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or
CLAUDE.local.md in a directory that is an ancestor of a changed file (a
directory's CLAUDE.md only applies to files at or below it). Read each one that
exists, then check the diff for clear violations of the rules they state.

Only flag a violation when you can quote the exact rule and the exact line that
breaks it — no style preferences, no vague "spirit of the doc" inferences. In
the finding, name the CLAUDE.md path and quote the rule so the report can cite
it. If no CLAUDE.md applies, return nothing for this angle.

### Pass every candidate through
Pass every candidate with a nameable failure scenario through to verify —
finders that silently drop half-believed candidates bypass the verify step and
are the dominant cause of misses.

## Phase 2 — Dedup and verify

Dedup near-duplicates (same defect, same location, same reason → keep one;
different reasons for the same line are NOT duplicates — at xhigh/max both
are kept per the suppression ban).

Then verify each candidate **grouped by location**. If the `subagent` tool is
available: group the deduplicated candidates by `(file, line)`; dispatch ONE
independent verify agent per group (mode: parallel, one prompt per group),
giving it the scope block, the diff, the relevant file(s), and the full
candidate list for that location with each candidate's index. The verifier
returns a verdict per candidate:

```
[{ "index": <candidate index>, "verdict": "CONFIRMED" | "PLAUSIBLE" | "REFUTED", "evidence": "<quote/argument>" }, ...]
```

Grouping is by location, NOT dedup — each candidate is judged independently;
same-location candidates may describe different defects. A candidate the
verifier omitted (interrupted or skipped an index) is **dropped** — never
invent a PLAUSIBLE for it. One verifier failure drops its whole group (the
same trade-off CC's workflow makes); if you are not confident in a group's
verifier, fall back to one verifier per candidate for that group.

This group-by-location verify is a deliberate absorption of CC's workflow
optimization into the inline path (CC inline dispatches one verifier per
candidate): a location with 3 candidates costs 1 verifier instead of 3 —
~40% fewer verifier agents is the expectation, not a guarantee.

If `subagent` is unavailable, fall back to re-checking each candidate yourself
(self-check). Keep **CONFIRMED and PLAUSIBLE**, drop REFUTED. Give each
surviving finding a verdict:

- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.

**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**Recall bias by level** — at high/xhigh/max, a single non-REFUTED verdict
keeps the candidate: do NOT drop it on uncertainty ("speculative", "depends
on runtime state"). That is the recall contract of high+. Medium is the
precision level: there, additionally weigh whether a maintainer would act on
the finding before keeping it.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.

## Phase 3 — Gap-hunt (xhigh / max only)

At **xhigh and max**, after Phase 2 dedup, dispatch ONE fresh finder agent (the
`subagent` tool) that has never seen the candidates and hunts only for gaps not
already listed — **at most 8 new candidates**. Feed anything it finds back
through Phase 2 verify before keeping it.

Constrain it so exploration can't run away (Pi adaptation — CC's workflow bounds
this differently):

1. **Pre-embed all context in the prompt** — do not tell the agent to search for
   callers/dependencies itself. Do those searches here first and embed the
   results: the diff, the enclosing functions, the deduplicated finding list,
   and any search results. The gap-hunt agent **analyzes**, it does not
   **discover**.
2. **Set `maxTurns: 15`** on the `subagent` call — caps it at 15 assistant turns.
3. **Declare a tool-call budget in the prompt** — e.g. "You have ONLY 3 tool
   calls to read files. Read them now, then analyze from this message's
   context."

Feed anything it finds back through Phase 2 verify before keeping it. If the
`subagent` tool is unavailable, take one self-sweep instead and note the
gap-hunt was self-run (lacks the independent fresh-eyes benefit).

At **high and below**, skip Phase 3.

## Output

Report the findings via the `review_report` tool (this extension's counterpart
to CC's `ReportFindings`) — call it **once** with
`{ level, target, files_changed, fanned_out, report_id, findings }`, findings
ranked most-severe first (empty array if nothing survived verification). The
tool renders the Chinese Markdown report (table + details) back to the
conversation AND writes a machine-readable JSON to `<cwd>/.pi/review/` for CI /
`--fix` / `--comment`. Do **not** also hand-write the Markdown table.

Each finding in the array carries: `file`, `line` (optional), `category`
(`correctness` / `reuse` / `simplification` / `efficiency` / `altitude` /
`conventions`, or a more specific slug like `test-coverage`), `verdict`
(`CONFIRMED` / `PLAUSIBLE`), `short_summary` (≤60 字符、纯声明——去掉理由与
后果，汇总表概述列优先使用它；示例：`"off-by-one in loop bound"`),
`summary` (一行中文，含理由与后果，详情块使用), `failure_scenario`
(concrete input/state → wrong output/crash; for cleanup findings, the
concrete cost — Chinese). When re-reporting after applying `--fix`, set
`outcome` on each finding (`fixed` / `skipped` / `no_change_needed` — CC
`ReportFindings` 三档，2.1.227 实证).

Cap = `maxFindings` from the effort table: `min(files_changed, 4)` at low; 8
at medium; 10 at high; 15 at xhigh/max. If more than the cap survive, send
the cap most severe (correctness outranks cleanup/altitude/conventions when
cutting; CONFIRMED outranks PLAUSIBLE). If nothing survives, send an empty
`findings` array — the tool prints a zero-count header.

**Fixed-later 义务** (CC `Q8m`): if, after this report, any later work in this
session fixes one of the reported findings (a user-requested fix, or a fix
that comes along with other changes), you MUST call `review_report` again
with the same `report_id`, the same findings, and updated `outcome` values —
before writing any text summary. The re-report updates states only; it does
not repeat the findings text. Generate the `report_id` (e.g. `review-<ts>`)
on the first report and reuse it on every re-report so consumers can merge
the files by id.

**全部用中文**：`summary` 与 `failure_scenario` 一律中文；`verdict`、`category`、
`outcome` 作为标识符保留英文 token。

**`fanned_out` 诚实** — 准确设置：仅当多智能体 fan-out 真的跑起来（subagent
finder + verify agent）才为 `true`；low effort 或任何单遍/自审降级为 `false`。该
字段会出现在报告表头，让读者不被误导（替代旧的 Single-pass honesty 小节）。

**降级** — 若 `review_report` 工具未注册（这份 SKILL.md 跑在 pi-review 扩展之外），
退回到直接打印 Markdown 表格 + 详情块文本；不要报错。

---

## Applying fixes (--fix)

The `--fix` flag was passed. After producing the findings list, apply the
findings to the working tree instead of stopping at the report: fix each one
directly — correctness bugs and reuse/simplification/efficiency cleanups alike.
Skip any finding whose fix would change intended behavior, require changes well
outside the reviewed diff, or that you judge to be a false positive — note the
skip rather than arguing with it. Then call `review_report` once more to
re-report (same `report_id`), setting `outcome` on each finding (`fixed` =
applied and verified / `skipped` = real but not applied, incl. reverted /
`no_change_needed` = not applicable or already handled). This structured
re-report replaces the hand-written summary and makes the fix result
machine-consumable.
If `review_report` is unavailable, fall back to a brief text summary of what was
fixed and what was skipped.

## Posting comments (--comment)

The `--comment` flag was passed. Post the findings as inline PR comments on the
corresponding `file`/`line`. If no GitHub commenting tool is available on Pi,
fall back to printing the findings as text and note that inline posting was
unavailable.

## Publishing a shareable review (--share)

The `--share` flag was passed. After producing the findings list, also publish
them as an artifact so they can be shared and iterated on outside the terminal.

1. Write a self-contained HTML review page to `.lavish/code-review-<n>.html`
   (create `.lavish/` in the repo root if missing). The page must render with no
   server and carry every finding plus its context.
2. Open it with `lavish-axi .lavish/code-review-<n>.html` so the reader can
   review, annotate, and send feedback back through the poll.

Page structure (follow lavish design guidance — clear visual hierarchy, no
horizontal overflow at any nesting level, monospace for code/paths, color-code
verdicts):

- **Header**: effort level, target, the diff command that was run, files-changed
  count, and whether the review actually fanned out (single-pass honesty).
- **Findings table**: one row per finding — `file:line`, `category`, `verdict`
  (CONFIRMED = red, PLAUSIBLE = amber, unset = grey), one-line `summary`, and
  the full `failure_scenario`.
- **Verdict legend**: a short note on what CONFIRMED vs PLAUSIBLE mean, so a
  non-author reader can discount the uncertain ones.
- **Context pins**: the changed-files list, the applicable CLAUDE.md files, and
  the conventions that were checked.

Skip the artifact if the review was invoked only to feed another tool (e.g.
`--fix`, where the caller applies its own changes) — note the skip in the
summary so the absence of a page is not mistaken for a failure.
