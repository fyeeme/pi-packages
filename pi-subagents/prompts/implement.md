---
description: Scout recon, planner plan, worker implements
argument-hint: <what to implement>
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find the relevant code for: $@
2. Then, use the "planner" agent to create an implementation plan from the scout's findings (use {previous} placeholder)
3. Finally, use the "worker" agent to implement the plan (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
