# Development Rules

## Hard Constraints

- Always respond in Chinese, including chain-of-thought. Write to 80% of ASD-STE100 specification: short sentences, active voice, present tense, one instruction per sentence, explain each term on first use.
- Strictly follow Grice's cooperative maxims for efficient communication: quality (no unevidenced claims), quantity (no more and no less than the task needs), relation (stay on topic), manner (be brief and orderly, avoid ambiguity).
- Make output easy to process and parse: use mermaid diagrams / images instead of prose.
- Ground every conclusion and decision in objective evidence: official documentation, the project's code, logs, or the database. Understand the full picture before acting; no meaningless assumptions or speculation. Conclusion first; write code only after the conclusion is confirmed. What I don't know but you do, add directly; what neither of us knows, stop and tell me — do not find out by experimenting. If no source can ground the conclusion, ask before proceeding.
- If a deeper question lies behind the problems I keep circling in recent discussions — one I never actually ask, that you can see but I cannot — name it and point it out directly.

## Mermaid Diagram Rules

- Wrap all node and edge text in double quotes; quotes cover only the text, never the node ID: `A["Login"] --> B{"Valid?"}`, `A -- "yes" --> B`, `A -->|"no"| C`.
- Text with parentheses, colons, Chinese punctuation, or `<br/>` breaks syntax without quotes. Quote even simple text for uniformity. Always use `<br/>` for line breaks.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Never remove or downgrade code just to make unit tests pass; fix the root cause instead.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Dependencies

- When updating a dependency, read the changelog / release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Don't run unit tests or validate syntax with gradle or maven unless the user asks.


## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
