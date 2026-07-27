# Workflow Notes

- **Goal Manager:** The persistent Codex session that owns GitHub issue selection, delegation, review, integration, evidence bookkeeping, and stopping conditions. It does not implement product code.
- **Implementation Worker:** A fresh-context agent assigned exactly one ready GitHub issue and an isolated worktree. It follows `/implement`, including TDD, code review, tests, and a commit.
- **Worker mechanism:** Native Codex subagents with no inherited conversation context. Separate Codex CLI processes are not used as a fallback.
- **Ready frontier:** Open issues in LocalHub #21–#51 whose native GitHub blockers are all closed.
- **Parallelism authority:** The live native GitHub blocker graph, as published from the approved issue map. The manager does not add subjective overlap dependencies absent from that graph.
- **Integration unit:** One ready GitHub pull request per issue. The PR preserves worker commits, CI, review, conflict, and handoff state; `main` receives one squash commit per completed issue.
- **Ordinary delivery:** Code, tests, local builds, commits, pushes, GitHub evidence comments, issue closure, and safe integration to `main`.
- **Human gate:** Physical-device or manual evidence, destructive action, spending, credentials, unresolved product decision, or unsafe merge conflict.
- **Human-gate brief:** One consolidated, decision-ready checkpoint containing exact issue and PR links, why each gate exists, attempts already made, step-by-step user actions, and the evidence needed to resume.
- If one issue reaches a human gate, the Goal Manager continues other reachable frontier work.
