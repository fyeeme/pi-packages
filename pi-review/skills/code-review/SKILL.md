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

  What CC 2.1.223 actually contains (verified against the binary):
    - Effort: medium = precision; high = recall ("err on the side of
      surfacing"); xhigh/max add a gap-hunt. Each finder surfaces ≤6 candidates.
    - Low effort: 1 diff pass, no verify, target min(files_changed, 4) findings.
    - Finder allocation (workflow Find-phase, linearized inline for Pi): one
      finder per correctness angle (A–E) + Conventions, plus one combined cleanup
      finder, pooled before verify. (CC's native *inline* medium path splits
      differently — 8 finders: 3 correctness + 3 cleanup + altitude + conventions.)
    - Angles A–E + Reuse/Simplification/Efficiency/Altitude + Conventions,
      verbatim (same source variables the /simplify skill reuses).
    - Verify via an independent agent: CONFIRMED / PLAUSIBLE / REFUTED,
      "PLAUSIBLE by default". Keep CONFIRMED + PLAUSIBLE, drop REFUTED.
    - Gap-hunt (xhigh/max): one fresh finder hunting only for gaps not
      already listed (CC's Sweep phase: "Fresh finder hunting only for gaps").
    - Output: Markdown findings table + per-finding details block, printed
      as text (no ReportFindings tool on Pi); carries file:line/category/
      verdict/summary/failure_scenario per finding.
    - --share publishes an Artifact; --fix applies findings to the working tree.

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
                  PRINTS a Markdown findings table + details block as text
                  (no such tool on Pi). [was JSON array; switched for
                  readability]
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

| Level | Intent | Verify | Subagents | Output cap |
|-------|--------|--------|-----------|------------|
| low (default) | quick scan | no | no | min(files_changed, 4) |
| medium | **precision** — surface only findings a maintainer would act on | independent agent | fan-out (1 finder/angle) | ≤ 8 |
| high | **recall** — catch every real bug a careful reviewer would; **err on the side of surfacing** | independent agent | more angles | ≤ 10 |
| xhigh → max | recall + **gap-hunt** | independent agent | above + 1 fresh gap finder | larger, may include uncertain |

Each finder surfaces **up to 6 candidate findings** with `file`, `line`, a
one-line `summary`, and a concrete `failure_scenario`.

If a target argument was provided, review that target instead of the whole diff.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run `git diff HEAD` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope. Note the
files-changed count — low effort uses it for the dynamic output cap.

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
that pass. Do not call a ReportFindings tool even if one is available.

---

# MEDIUM-AND-ABOVE FLOW  (fan-out + verify)

## Phase 1 — Find candidates (single pass or parallel fan-out)

Work through the angles below. If the `subagent` tool is available, launch
finder agents in a single batch (mode: parallel) so they run concurrently;
otherwise do not fake the fan-out — work the angles yourself in sequence in
this same context, or report that the subagent capability is unavailable.

**Finder allocation** (the workflow Find-phase, linearized inline for Pi;
verbatim from the binary): **one finder per correctness angle, plus one finder
covering all cleanup angles, pooled before verify** — not a priority-sorted
packing. That is one finder each for A/B/C/D/E plus Conventions, and one
combined finder for the cleanup angles (Reuse / Simplification / Efficiency /
Altitude). Never silently drop a correctness angle; if you must consolidate,
fold cleanup into a correctness finder.

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
Flag new code that re-implements something the codebase already has — Grep
shared/utility modules and files adjacent to the change, and name the existing
helper to call instead.

### Simplification
Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name the
simpler form that does the same job.

### Efficiency
Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or hot
paths. Also flag long-lived objects built from closures or captured environments
— they keep the entire enclosing scope alive for the object's lifetime (a memory
leak when that scope holds large values); prefer a class/struct that copies only
the fields it needs. Name the cheaper alternative.

### Altitude
Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix isn't
deep enough — prefer generalizing the underlying mechanism over adding special
cases.

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

Dedup near-duplicates (same defect, same location, same reason → keep one).

Then verify each candidate. If the `subagent` tool is available, dispatch an
independent verify agent (one per candidate, or a small batch): give it the
diff, the relevant file(s), and the candidate; it returns exactly one of
**CONFIRMED / PLAUSIBLE / REFUTED**. An independent agent counters the
confirmation bias of self-review. If `subagent` is unavailable, fall back to
re-checking each candidate yourself (self-check). Keep **CONFIRMED and
PLAUSIBLE**, drop REFUTED. Give each surviving finding a verdict:

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

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.

## Phase 3 — Gap-hunt (xhigh / max only)

At **xhigh and max**, after Phase 2 dedup, dispatch ONE fresh finder agent (the
`subagent` tool) that has never seen the candidates and hunts only for gaps not
already listed.

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

Print the findings as a **Markdown table + a details block** — readable in a
terminal and in rendered Markdown (no JSON, no ReportFindings tool on Pi). Cap =
low's min(files_changed, 4); 8 at medium; 10 at high; larger at xhigh → max.

**全部用中文输出**：表头、概述、场景一律用中文；`Verdict`、`Category` 作为标识符保留
英文 token（CONFIRMED / PLAUSIBLE；correctness / reuse …）。

**1. 表头行** — 单行写明：力度、diff 命令/范围、改动文件数、命中条数、是否真的多智能体
并发（见下文 Single-pass honesty）。示例：

> `max` · `git diff HEAD` · 29 个文件 · 3 条发现 · 多智能体（验证 + 查漏）

**2. 发现汇总表** — 按严重程度从高到低，每条一行：

| # | 判定 | 类别 | 位置 | 概述 |
|---|------|------|------|------|
| 1 | CONFIRMED | correctness | path/file.ext:123 | 一句话说明这个 bug |
| 2 | PLAUSIBLE | reuse | path/file.ext:45 | … |

- `判定` — `CONFIRMED` / `PLAUSIBLE` / 留空（未做验证）。
- `类别` — 产生该发现的角度，短横线小写 slug（`correctness`、`simplification`、
  `efficiency`、`reuse`、`altitude`、`conventions`，或更具体的如 `test-coverage`）。
- `位置` — `文件:行号`。
- `概述` — 一句话说明（≤ 约 80 字，同时作为紧凑标签）。

**3. 详情块** — 与表格同序；场景放不进单元格，在这里展开：

**1. path/file.ext:123 — 类别** *(判定)*
概述：<一句话>
场景：<具体的输入/状态 → 错误输出/崩溃；若是清理类发现，写明具体代价——重复了什么、
浪费了什么、哪里更难维护，或违反了哪条规则>

If more than `{cap}` survive, keep the `{cap}` most severe (correctness outranks
cleanup/altitude/conventions when cutting). If nothing survives, print the header
line with count 0 and skip the table and details — don't emit an empty table.

### Single-pass honesty

If this review did not actually fan out — low effort, or medium+ where the
`subagent` tool was unavailable so the angles ran sequentially in one context —
state clearly in the header line that this was a single-pass review done without the
multi-agent fan-out, so whoever reads it isn't misled about what actually ran.

---

## Applying fixes (--fix)

The `--fix` flag was passed. After producing the findings list, apply the
findings to the working tree instead of stopping at the report: fix each one
directly — correctness bugs and reuse/simplification/efficiency cleanups alike.
Skip any finding whose fix would change intended behavior, require changes well
outside the reviewed diff, or that you judge to be a false positive — note the
skip rather than arguing with it. Finish with a brief summary of what was fixed
and what was skipped.

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
