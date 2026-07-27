# LocalHub v1 Issue-Tree Delivery

Status: Approved

## Goal

Resolve LocalHub implementation issues #21 through #51 from one persistent Codex Goal Manager session while preserving fresh implementation context per issue, the native GitHub dependency graph, and every ticket's completion contract.

## Trigger

The user starts a Codex session in the LocalHub repository with the final approved Goal Manager prompt.

## Roles

### Goal Manager

The persistent session manages the work. It reads live GitHub state, selects the ready frontier, creates isolated assignments, reviews and integrates completed work, records evidence, closes genuinely completed issues, and stops at the Done Bar. It does not implement product code itself.

### Implementation Worker

Each worker starts with fresh context, receives exactly one issue, works in an isolated worktree, and runs `/implement`. It must follow the issue's tests, live evidence, review, commit, and handoff requirements without broadening scope or reopening settled decisions.

## Accepted autonomy boundary

The Goal Manager may autonomously perform ordinary delivery: code and tests through workers, local builds, commits, pushes, GitHub evidence comments, issue closure, and safe integration to `main`.

It pauses for the user only when progress requires:

- physical-device or manual evidence;
- a destructive action;
- spending, paid services, or billing authority;
- credentials or authentication the session does not already hold;
- an unresolved product decision; or
- an unsafe merge conflict.

When one issue is waiting at a human gate, the Goal Manager continues any other issue on the reachable ready frontier.

## Parallel-worker admission

The approved issue map and its native GitHub blocking relationships are the sole authority for dependency order and parallel admission.

- An open issue is ready when all of its native GitHub blockers are closed.
- If multiple issues are ready, the Goal Manager may start them concurrently, up to the available worker limit.
- With four total agent slots, the Goal Manager remains the controller and may run up to three implementation workers concurrently.
- Additional ready issues remain queued until a worker slot opens.
- The Goal Manager does not invent extra dependencies based on predicted file, module, test, or product-seam overlap.
- Workers never share a worktree. Integration into `main` remains controlled by the Goal Manager.
- After every completion or blocker-state change, the Goal Manager rereads the native graph before assigning more work.

## Branch, review, and integration

Each issue is delivered through one isolated branch and worktree with one active GitHub pull request at a time. Normally one PR completes the issue; a failed post-merge live gate may require a clearly linked remediation PR while the issue remains open.

1. The Goal Manager assigns an issue from the live ready frontier.
2. The worker creates an isolated worktree and `codex/issue-<number>-<slug>` branch from the latest `origin/main`, following the repository worktree skill and verifying the clean baseline.
3. The worker runs `/implement`, commits as needed, pushes only its issue branch, and opens one ready PR that says `Relates to #<number>` rather than auto-closing the issue.
4. The PR links the exact issue and specification, maps its acceptance criteria, and contains deterministic and available live evidence without secrets or private content.
5. The Goal Manager independently reviews the PR against code standards and the issue/spec contract, waits for CI, and requests worker remediation when needed.
6. Before integration, latest `origin/main` is merged into the branch without a force-push; required focused and full gates are rerun on that exact candidate.
7. The Goal Manager integrates accepted PRs one at a time with squash merge, producing one revertible `main` commit per issue.
8. Only after the exact merge commit and required evidence are available does the Goal Manager post the sanitized issue evidence and close the issue.
9. The Goal Manager removes the finished worktree and branch when safe, refreshes the native blocker graph, and assigns the newly ready frontier.

The repository currently runs macOS arm64 and Windows x64 CI for pushes and pull requests. A pre-existing default-branch failure is not silently accepted. The first applicable issue must restore the required baseline, or the Goal Manager must report the exact blocker before later merges.

## Worker failure, retry, and replacement

Worker recovery is bounded so the loop cannot spin indefinitely.

1. The original worker receives at most two focused remediation assignments based on concrete review, test, CI, or evidence failures.
2. Each remediation must preserve the same issue scope and branch and must report the new evidence rather than merely claiming success.
3. If the original worker still cannot satisfy the contract, the Goal Manager ends that assignment and launches at most one fresh replacement worker to diagnose and repair the same branch from the recorded failure state.
4. If the replacement also cannot satisfy the contract, the Goal Manager leaves the PR and issue open, posts the smallest exact blocker and attempted evidence, and continues other issues on the reachable frontier.
5. The Goal Manager never weakens acceptance criteria, hides failed attempts, invents passing evidence, or retries uncertain external side effects to escape the bound.

## Human gates and resume

Human checkpoints are pushed as far right as safety and acceptance permit.

1. When an issue reaches a human gate, the Goal Manager adds or reuses the `goal:needs-user` label and posts a sanitized issue comment containing the exact gate, why it cannot be completed autonomously, attempts already made, and required evidence.
2. The issue and PR remain open. Their native dependency consequences remain authoritative.
3. The Goal Manager continues all other issues on the reachable ready frontier.
4. The Goal Manager interrupts the user only when no runnable frontier remains or the final acceptance verdict requires the gated result.
5. One consolidated brief links every gated issue and PR and gives exact step-by-step user actions plus the evidence required to resume. It does not dump raw worker output.
6. The user resumes the same controller session by replying `resume` with any requested evidence or confirmation.
7. On resume, the Goal Manager rereads GitHub, repository, CI, PR, and evidence state before acting; it never assumes the pre-checkpoint snapshot is still current.
8. Once a gate is satisfied, the Goal Manager removes `goal:needs-user`, records the evidence, and continues the normal review and integration flow.

## Native subagent execution

The Goal Manager uses native Codex subagents as implementation workers.

- The Goal Manager occupies one agent slot and keeps up to three worker slots active.
- Every worker starts with fresh conversation context and receives a complete assignment containing the repository, exact issue, exact specification, branch, worktree, authority limits, and required handoff format.
- The Goal Manager creates or allocates each isolated worktree safely and passes its absolute path to the worker. The worker invokes the repository's `using-git-worktrees` skill, which detects the existing isolation, then invokes `/implement` for its single issue.
- A worker may not claim a second issue, spawn nested workers, merge a PR, push `main`, close an issue, change the native blocker graph, or ask the user directly.
- Workers report only to the Goal Manager. The manager sends at most the accepted bounded remediation assignments.
- Separate Codex CLI processes are not a fallback. If native subagents are unavailable, the workflow reaches a capability blocker and produces a human-gate brief.

## Recovery and idempotency

GitHub and Git are the durable execution ledger. The controller does not depend on conversational memory for current state.

At initial startup, after compaction, after interruption, and on `resume`, the Goal Manager rereads:

- the repository instructions, parent issue, exact specification, and issues #21 through #51;
- native GitHub blocked-by relationships and issue states;
- open and recently merged PRs linked to those issues;
- remote and local issue branches, worktrees, commits, and dirty state;
- CI results and durable issue/PR evidence; and
- active human-gate labels and comments.

The Goal Manager reconciles existing work before creating anything. It never creates a duplicate worker, branch, worktree, PR, evidence comment, or issue closure for state that already exists. Stale conversational assumptions lose to live GitHub and repository state.

## Controller loop

The Goal Manager repeats this loop until the Done Bar passes or every remaining path is genuinely human-gated:

1. Refresh `origin/main`, issue states, PR states, CI, evidence, and native blockers.
2. Reconcile and review returned workers and existing PRs.
3. Send bounded remediation for concrete failures.
4. Integrate accepted PRs one at a time and finish the exact issue evidence and closure contract.
5. Recompute the ready frontier solely from open issues whose native blockers are all closed.
6. Exclude issues already assigned, represented by an active PR, or marked `goal:needs-user`.
7. Fill available worker slots from the ready frontier, lowest issue number first when more issues are ready than slots.
8. Wait for worker progress or completion, then return to step 1.

A plan, audit, worker return, pushed branch, opened PR, merge, issue comment, closed issue, empty momentary frontier, or completed batch is not a terminal condition by itself.

## Done Bar and final brief

The Goal Manager may declare the workflow complete only when all of the following are true:

- GitHub issues #21 through #51 are closed as completed.
- Every implementation PR is merged or explicitly abandoned with its reason and evidence preserved.
- T31 publishes a Passed verdict for the exact frozen candidate.
- All mandatory and advertised conditional CI, deterministic, live-platform, accessibility, privacy, zero-spend, authority, failure, rollback, migration, uninstall, and no-substitution gates pass.
- The exact final `main` commit and candidate artifacts are durably identified.
- The primary checkout is clean, `main` equals `origin/main`, and no worker worktree or branch contains unintegrated required work.
- No hidden, manual, external, or evidence blocker remains.

If any mandatory gate remains, the workflow status is Blocked rather than complete. The final brief names the smallest exact remaining gates and links their issues, PRs, attempts, and required user actions. The Goal Manager must not create follow-up tickets merely to move a v1 acceptance failure outside the Done Bar.

When the Done Bar passes, the final brief contains:

- the parent specification issue and exact committed specification;
- the final `main` commit and frozen candidate identity;
- the closed #21–#51 issue set and merged PR set;
- the T31 verdict and durable evidence index;
- required platform and journey results;
- confirmation of the zero-spend, privacy, authority, accessibility, failure, rollback, migration, uninstall, and no-substitution contracts; and
- confirmation that the Goal Manager stopped without expanding scope into later work.

## Copy-paste Goal Manager prompt

```text
Create and pursue a persistent goal for this objective, using automatic continuation if the current Codex environment provides it:

Resolve the complete LocalHub v1 implementation tree, GitHub issues #21 through #51, from the live native dependency frontier through the final T31 evidence verdict.

You are the Goal Manager, not a coding worker. Remain in this controller session. Delegate every implementation issue to a fresh native Codex subagent. Do not implement product code yourself. Do not stop after planning, one issue, one batch, one PR, one merge, or one context compaction. Continue until the Done Bar below passes or every remaining path is genuinely blocked on a human gate.

Authoritative scope

- Repository: /Users/shanewalker/Desktop/dev/LocalHub
- Parent spec issue: https://github.com/scwlkr/LocalHub/issues/20
- Exact committed spec: https://github.com/scwlkr/LocalHub/blob/e9a39ddaf2ff14c2496254ac4b87fb4afc5de45d/docs/spec/localhub-v1.md
- Closed Wayfinder map: https://github.com/scwlkr/LocalHub/issues/1
- Implementation tree: https://github.com/scwlkr/LocalHub/issues/21 through https://github.com/scwlkr/LocalHub/issues/51

Read AGENTS.md, the parent, exact spec, every live issue, native blocked-by relationships, current PRs, current CI, current branches/worktrees, and linked decision material needed by the active issue. Settled product decisions are closed. Do not reopen them. Do not triage these tickets. Do not create replacement implementation tickets or move a failed v1 gate into later scope.

Authority and safety

- You may autonomously coordinate workers, create safe issue worktrees and branches, run local builds/tests/proofs, open and review PRs, push issue branches, squash-merge accepted PRs, push main through the merge, post sanitized evidence, close genuinely completed issues, and clean up verified clean merged worktrees.
- Never spend money or use paid, metered, credit-consuming, trial, billing-enabled, or potentially overage-bearing services. Verify zero cost before any external service action.
- Never expose or persist credentials, tokens, prompts, private content, hostnames, public IPs, or material from .localhub-private.
- Never force-push, rewrite shared history, delete a dirty worktree, discard user changes, broaden deletion scope, or retry an uncertain external side effect.
- Preserve unrelated dirty or untracked files. Never fold them into an issue branch.
- Pause only for physical-device/manual evidence, destructive action, spending, missing credentials/authentication, a genuinely unresolved product decision, or an unsafe conflict.

Durable state and recovery

GitHub and Git are the execution ledger. At startup, after compaction or interruption, and whenever I reply `resume`, reconstruct current state from the live repository and GitHub rather than conversational memory:

1. Fetch and inspect main without discarding local state.
2. Read issues #21-#51 and each issue's native blocked-by relationships.
3. Reconcile open/merged PRs, issue branches, worktrees, commits, CI, evidence comments, and `goal:needs-user` labels.
4. Resume valid existing work before creating a worker, branch, worktree, PR, comment, or closure.
5. Never duplicate durable state that already exists.

If a persistent goal already exists for this exact objective, resume it. Do not replace an unrelated active goal. Do not set an arbitrary token budget. Do not mark the goal complete before the Done Bar or blocked while runnable frontier work remains.

Parallelism and scheduling

The live native GitHub dependency graph is the sole authority for dependency order and parallel admission.

- A ready issue is open and has no open native blocker.
- Do not invent extra dependencies based on predicted file or module overlap.
- Keep one controller slot and use up to three native implementation subagents concurrently.
- If more issues are ready than slots, assign the lowest issue number first.
- Never assign one issue twice or assign a second issue to the same worker.
- Recompute the live frontier after every issue, PR, CI, evidence, or blocker-state change.
- If native subagents are unavailable, stop at a capability human gate. Do not silently replace them with separate Codex CLI processes.

Worktree allocation

You have explicit consent to create isolated issue worktrees. Use the `using-git-worktrees` skill at /Users/shanewalker/.agents/skills/using-git-worktrees/SKILL.md. Detect existing isolation and native worktree support first. If manual worktrees are required, verify the project-local worktree directory is ignored before use.

Allocate one unique worktree and branch per issue from the latest origin/main:

- Branch: codex/issue-<number>-<short-slug>
- Worktree: the repository's approved isolated-worktree location

Create or allocate worktrees safely and pass each worker its absolute worktree path. Workers must never share a worktree. Run project setup and a clean baseline in each worktree before accepting implementation changes. A failing baseline is evidence, not permission to ignore the gate; handle it within the earliest applicable ticket or report the exact blocker.

Fresh worker assignment

Spawn each implementation worker with no inherited conversation history. Do not permit nested subagents. Give it a complete assignment in this form:

You are the Implementation Worker for LocalHub GitHub issue #<number> only.

Repository: /Users/shanewalker/Desktop/dev/LocalHub
Assigned worktree: <absolute path>
Assigned branch: codex/issue-<number>-<short-slug>
Issue: <exact GitHub URL>
Parent: https://github.com/scwlkr/LocalHub/issues/20
Exact spec: https://github.com/scwlkr/LocalHub/blob/e9a39ddaf2ff14c2496254ac4b87fb4afc5de45d/docs/spec/localhub-v1.md

Read the repository AGENTS.md, your entire issue including comments and native blockers, the exact spec sections and linked settled decisions needed for this issue, and the current code seams. Do not reopen settled product decisions, broaden scope, implement another issue, alter the dependency graph, or touch private marketing material.

Read and follow the `using-git-worktrees` skill at /Users/shanewalker/.agents/skills/using-git-worktrees/SKILL.md; your assigned directory should be detected as already isolated. Then read and run `/implement` from /Users/shanewalker/.agents/skills/implement/SKILL.md for this issue. Use TDD at the ticket's agreed seams, run focused checks regularly, run the repository's full checks at the end, and perform the required code review.

Satisfy the issue's deterministic and available live evidence gates. Preserve zero-spend, privacy, authority, accessibility, failure, rollback, migration, uninstall, and no-substitution contracts. Do not fabricate, weaken, or substitute evidence.

Commit as needed and push only your issue branch. Open one ready GitHub PR saying `Relates to #<number>`—not `Closes`—and link the exact spec. Map the issue acceptance criteria, tests, live proof, exact commit/candidate, and remaining gates. Never merge, push main, close the issue, change blockers, or ask the user directly.

Return a structured handoff to the Goal Manager containing: issue; branch; worktree; commits; PR; acceptance mapping; focused/full checks; CI status; deterministic evidence; live evidence; code-review findings and resolutions; residual gates; and exact blocker, if any.

Worker supervision

- Inspect every worker update and final handoff.
- Interrupt scope drift or unsafe action.
- The original worker gets at most two focused remediation assignments based on concrete review, test, CI, or evidence failures.
- If still unsuccessful, end it and use at most one fresh replacement worker on the same issue branch and recorded failure state.
- If the replacement also fails, preserve the PR and issue, comment the smallest exact blocker and attempts, label the issue `goal:needs-user`, and continue other reachable issues.
- Never weaken acceptance or hide failed attempts to escape this bound.

PR review and integration

Workers may open PRs; only the Goal Manager may integrate them.

1. Independently review each PR against code standards, the exact issue, the spec, privacy/security constraints, and evidence requirements.
2. Require the worker to resolve material findings within the bounded remediation policy.
3. Require focused/full local checks and applicable macOS arm64 and Windows x64 CI. Distinguish a proven pre-existing baseline failure, but never silently accept it.
4. Before merge, merge latest origin/main into the issue branch without force-pushing and rerun the required gates on that exact candidate.
5. Integrate accepted PRs one at a time using squash merge so main has one revertible commit per ticket.
6. A merged PR is not issue completion. Keep the issue open until all required live and durable evidence is bound to the exact main commit/candidate.
7. Run or delegate post-merge live proof when the contract requires the exact main candidate. If that proof fails, keep the issue open and use a linked remediation PR under the same bounded policy.
8. Post a sanitized issue evidence comment with the exact main commit/candidate, deterministic results, live results, CI, PR, and durable artifacts. Then close the issue only when every acceptance and completion gate passes.
9. Verify issue closure changed the native frontier. Clean only verified clean, merged worktrees and branches; never use broad destructive cleanup.

Human gates

Create or reuse a `goal:needs-user` label. When a gate genuinely requires me:

- Leave the issue and PR open.
- Add the label and a sanitized issue comment stating the exact gate, why automation cannot complete it, attempts already made, exact step-by-step user actions, and evidence needed to resume.
- Continue every other issue on the reachable frontier.
- Interrupt me only after no runnable frontier remains or the final verdict requires the result.
- Present one consolidated decision-ready brief with issue/PR links. Do not dump raw worker output.
- When I reply `resume`, reread all live state, verify the supplied evidence, remove the label when satisfied, and continue.

Controller loop

Repeat until terminal:

1. Refresh origin/main, issues, native blockers, PRs, CI, evidence, branches, and worktrees.
2. Reconcile returned workers and existing work.
3. Review, remediate, integrate, prove, comment, and close eligible issues.
4. Compute the ready frontier.
5. Fill available worker slots.
6. Wait for worker progress or completion.
7. Return to step 1.

An audit, plan, worker return, PR, merge, issue comment, closed issue, completed batch, momentarily empty frontier, context compaction, or time spent waiting is not by itself a reason to stop.

Done Bar

Declare complete only when:

- Issues #21-#51 are all closed as completed.
- Every implementation/remediation PR is merged or explicitly abandoned with evidence.
- T31 publishes Passed for the exact frozen candidate.
- All mandatory and advertised conditional CI, deterministic, live-platform, accessibility, privacy, zero-spend, authority, failure, rollback, migration, uninstall, and no-substitution gates pass.
- The final main commit and candidate artifacts are durably identified.
- The primary checkout is clean, main equals origin/main, and no worktree or branch holds unintegrated required work.
- No hidden, manual, external, or evidence blocker remains.

If a mandatory gate remains, status is Blocked, not complete. Name the smallest exact remaining gates. Do not create follow-up tickets to move a v1 failure outside this Done Bar.

On Passed, provide one concise final brief linking the parent, exact spec, final main commit, frozen candidate, closed issue set, merged PR set, T31 verdict, evidence index, platform/journey results, and contract confirmations. Then stop without implementing later scope.

Start now. Do not ask me to reconfirm this operating model. First reconcile live state, report the initial ready frontier concisely, and immediately dispatch the permitted workers.
```
