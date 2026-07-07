# GitHub-native issue-driven development flow (vs Jira/Linear/markdown) — research brief
_scope: last ~6mo (2025–2026 sentiment), generic dev-tooling lens, deep dive • generated 2026-07-02_
_source tags: [R]=Reddit • [E]=Exa web. Inline citations name the specific site/subreddit so every claim is traceable._
_Purpose: decide whether to move piflow's roadmap off `STATUS.md`/`PRD.md`-style tracking onto a GitHub-native issue → sub-issue → Projects/Milestones flow, driven by the `gh` CLI + Claude Code._

## How to read this
Almost everything below is **practitioner experience + vendor docs**, with ONE empirically-grounded anchor
(the Bui et al. arXiv study on ticket quality). Where a claim is a benchmarked number vs. an anecdote, it's marked.
The Reddit leg found the topic is **under-posted** (people debate Jira-vs-Linear loudly but rarely nominate
GitHub Projects) — treat that as a real signal, not a search miss. The web (Exa) leg is where the strong,
concrete signal lives.

## TL;DR
- **The pattern you described is a real, named, 2026-current practice — "issue-driven development" (IDD)**: manage rich GitHub Issues instead of `tasks.md`/`architecture.md`, decompose into **sub-issues** (GA since Apr 2025, up to 8 levels, auto progress rollup), drive it all from the `gh` CLI. [E: brianchambers.substack.com, github.blog]
- **For a solo dev / ≤5-person team living in GitHub, the cross-source verdict is: use GitHub Issues, not Linear/Jira.** The consensus breakpoint where teams should switch to Linear is **~300–500 open tickets** (or ~15–30 people). Below that, GitHub-native wins on zero context-switching + price ($4/user/mo vs Linear $8, Jira $7.75). [E: stackfyi, cotera, workmanagementhub]
- **Reddit's loud sentiment is "leaving Jira for Linear" — GitHub Projects is often not even on the shortlist.** So GitHub-native-as-primary-roadmap is *under-discussed*, not disproven; the people doing it are writing blog posts, not Reddit threads. [R: r/webdev 247pts]
- **The AI-agent angle is the fastest-moving part and directly favors GitHub-native.** "Issue tracker as the agent dispatch surface" is now a codified pattern; **ticket quality predicts agent-PR merge at 72% AUC** (the ticket, not the model, dominates success). Agent-authored PRs on GitHub went **4M → 17M in 6 months** (Sep 2025 → Mar 2026). [E: agentpatterns.ai citing arXiv 2512.21426]
- **Spec-driven development (GitHub Spec Kit) is the formalized 2026 version of your current PRD flow** — and it has a `/speckit.taskstoissues` command that turns a spec's task list directly into GitHub issues. Agent-neutral (Claude, Copilot, Codex, Cursor, 30+). [E: github.github.com/spec-kit]

## Key findings (in depth)

### 1. "Issue-driven development" is the exact pattern you sketched
Brian Chambers' write-up is the cleanest statement [E: brianchambers.substack.com, 2025-11]: *"we shift from
managing `architecture.md` and `tasks.md` files to managing only rich tasks which are stored in an 'issue'."*
The loop is three prompts to a coding agent:
1. *"Take each of these tasks and create a GitHub issue for them one-by-one. Add them to the project named '…'."*
2. (Plan Mode) *"Pull issue #107, read it thoroughly, make a plan… update issue #107 with this plan and move it to 'Ready'."*
3. *"Pull issue #107… write behavioral tests first and write code until they pass. Do the work in a new branch, execute the task completely, push, create a PR. Move the task to 'In Review' when complete."*

This is the same shape as your current `STATUS.md` + `PRD.md` habit, except the durable artifact is the **issue
body** (queryable, linkable, assignable) instead of a markdown file. It maps 1:1 onto your existing `docs/design/`
and `docs/research/` docs — the issue *references* the research doc; it doesn't replace it.

A stricter variant fences agent scope with a spec-shaped issue file [E: zenn.dev/yktsnet, 2026-04]: each `issues/*.md`
carries `Target:` (exact files allowed to edit — prevents context pollution), `Verification:` (lint/typecheck the
agent must self-run), and `status: draft|open`. *"If you send messy requests, you get messy responses back."*

### 2. Sub-issues, Projects hierarchy, and `gh` are now first-class (the mechanism exists)
- **Sub-issues GA April 2025** alongside issue *types* and advanced search (AND/OR/nested). Up to **8 levels** of
  hierarchy, **automatic parent progress rollup**, Projects item limit raised to **50,000**. The old **tasklist
  blocks were retired April 30, 2025** and replaced by sub-issues ("convert checklist items to sub-issues"). [E: github.blog engineering + changelog]
- **Projects hierarchy view** (expand/collapse the full 8-level sub-issue tree in table views, group/slice/sort/filter
  while preserving hierarchy) went public preview **Jan 2026**. This is your roadmap overview surface. [E: github.blog 2026-01-15]
- **`gh` CLI got sub-issue / type / dependency management in June 2026** (v2.94.0): `gh issue edit 10 --parent 5`,
  `gh issue edit 10 --blocked-by 7`, `gh issue view 1 --json …,parent`. *"What was once a flat list of issues is now
  a structured system of relationships, dependencies, and typed workflows that behave almost like a living project
  graph."* [E: github.blog changelog 2026-06-10]

### 3. GitHub-native vs Linear vs Jira — the honest tradeoff
The three independent comparison pieces converge [E: stackfyi, cotera, workmanagementhub, all 2026]:
- **GitHub Issues** — right default for OSS + any team that lives entirely in GitHub and wants **zero
  context-switching**. Weak spots: no velocity/cycle analytics, Milestones are coarse (no sprint velocity),
  search degrades with volume. Verdict: *"team of five or fewer working on a single repo, start with GitHub Issues."*
- **The breakpoint is quantified.** Cotera: one team's search went to 2–3 min/query at ~500 issues (*"we should have
  moved at 300 instead of 500"*); migrating ~340 issues took ~15 min with a script. WorkManagementHub: the pain
  *"consistently reported"* around **500 open tickets**, hit *"between 15 and 30 people."*
- **Linear** — the dev-favorite once you cross that line (cycles, velocity, polish). **Jira** — widely resented as
  bloat (*"we only use 3–5% of what JIRA offers… paying premium prices for bloat"* [R: r/webdev 247pts]); the loud
  Reddit migration is Jira → Linear, and **GitHub Projects is frequently absent from the shortlist** — an adoption/
  mindshare gap, not a capability verdict.
- Pricing cited across sources: **GitHub Team $4/user/mo · Linear $8 · Jira $7.75**.

### 4. The AI-agent angle (this is where GitHub-native pulls ahead for you)
- **"Issue tracker as the fourth agent invocation surface"** (after IDE, chat, REST API) is now a codified pattern,
  identical in contract across GitHub/Jira/Linear as of mid-2026. [E: agentpatterns.ai]
- **Empirical anchor (the one hard number):** a study of 2,000+ Copilot-assigned issues found **ticket-quality
  features alone predict merge outcome at 72% AUC** — the ticket dominates success variance, not the model. Verbose
  descriptions *cut* merge likelihood ~9%; external-dependency mentions 4–9%. (Bui et al., arXiv **2512.21426**,
  cited second-hand — worth fetching directly before quoting in anything formal.)
- **GitHub's official ticket-for-agent discipline = "WRAP"**: **W**rite effective issues (clear title, context,
  examples), **R**efine instructions (repo/org custom instructions), **A**tomic tasks (one issue = one concern),
  **P**air with the agent (human in review). [E: agentpatterns.ai]
- **Copilot coding agent** turns an assigned issue into a PR: assign (via web, mobile, **or `gh`**) → 👀 reaction →
  Actions session → reads issue, breaks into a checklist, writes code, runs tests, requests review. Key gotcha:
  *"Copilot receives the issue title, description, and existing comments at assignment time. It does not see comments
  added after assignment"* → *"think of the issue you assign to Copilot as a prompt."* [E: github.blog 2025-06]
- **Scale + broken edges:** agent-authored PRs jumped **4M (Sep 2025) → 17M (Mar 2026)**, anecdotally "1 in 10
  legitimate," which is why GitHub shipped a kill switch and tools added `hide-older-comments`. On Reddit, the
  loudest agent-mode thread is a *warning*: **"If you create a long to-do list in agent mode, you will be banned"**
  (207 pts) — leaning on the agent's own task-list at scale trips abuse limits. And you need an **assignment-vs-
  mention convention** (assign = new session; `@mention` = resume) or parallel sessions race on the same branch. [E/R]

### 5. Open-source orchestrators that already use issues as the agent queue
All are `gh`-based and worth studying as prior art for a piflow-flavored runner:
- **Baton** [E: muhammadraza.me, 2026-03] — polls `gh issue list` by label every 30s, **one git worktree per issue**,
  runs **Claude Code CLI**, opens a PR, moves to the next. Explicitly *"gh CLI instead of the GitHub API… authenticate
  once (`gh auth login`) and everything on your machine uses the same credentials."* Config: `tracker.labels`,
  `agent.max_concurrent`, `agent.max_turns`. (Reworked from OpenAI's "Symphony" spec, which used Codex + Linear.)
- **Epic-driven + `copilot-auto-queue`** [E: maskaravivek.com] — an epic is a GitHub issue with a checklist of
  `- [ ] #123`; a `gh`+`jq` script assigns the next issue to Copilot, waits for PR checks, merges, moves on.
  *"The right level is a single reviewable unit of behavior."*
- **Tiki, three-body-agent, agent-kanban (`ak`), claude-gh-task-manager, Jan Keijzer's `/decompose` skills** — a small
  cottage industry of "issues → worktree → agent → PR" sequencers (2026), several multi-runtime (Claude Code, Codex,
  Gemini, Copilot CLI). Jan Keijzer reports `/decompose` eliminated *"20–30 minutes of pure overhead for each large
  feature."*

### 6. The discipline conventions that keep it from drifting (your actual goal)
- **1-1-1-1-1** [E: dmyersturnbull.github.io]: *"1-1-1-1-1 correspondence between issues, feature branches, pull
  requests, commits to main, and changelog items."* Exactly one `type:` label per issue; split large issues into
  bite-sized sub-issues listed in the parent. (Squash-merge; this matches your existing `--no-ff` branch-per-unit habit.)
- **The solo-dev issue template** [E: dev.to/southwestmogrown]: what+why (1–2 sentences), in-scope, **out-of-scope
  ("the most important line")**, definition of done, task checklist. Branch `feat/42-…`, commit `Closes #42`, draft
  PR early for multi-session work. The **out-of-scope line + Milestones + the Projects roadmap view is the anti-drift
  mechanism** — the thing that answers "am I still on my important goal?"

## What's working (claimed)
- Rich issues as the single source of truth, `gh`-driven, agent-pulled [E: brianchambers, zenn.dev].
- Sub-issue decomposition with auto progress rollup + Projects hierarchy view for the overview [E: github.blog].
- Spec Kit's `specify → plan → tasks → taskstoissues → implement` for turning a PRD into issues agent-neutrally [E: spec-kit].
- Issues as an agent task queue via a thin `gh`+`jq` sequencer + worktree-per-issue [E: Baton, epic-driven].
- 1-1-1-1-1 + out-of-scope-line discipline for staying on-goal [E: maintainer-guide, dev.to].

## What's broken / contested
- **Mindshare gap:** teams leaving Jira pick Linear; GitHub Projects rarely makes their shortlist [R: r/webdev]. Real capability, weak reputation-as-a-PM-tool.
- **Volume ceiling:** GitHub Issues search + coarse Milestones degrade past ~300–500 open tickets [E: cotera, workmanagementhub]. (Irrelevant at your solo scale — but note it.)
- **Agent-mode abuse limits:** big auto-generated to-do lists / long agent task-lists can get you rate-limited or banned [R: r/GithubCopilot 207pts].
- **Comment-timing gotcha:** Copilot only sees the issue + comments present *at assignment*; late context must go on the PR [E: github.blog].
- **`gh` CLI scripting is finicky:** multi-line PR bodies need heredocs + careful escaping [E: Jan Keijzer].
- **Spec Kit token cost:** budget **~20–40% more tokens per feature** (offset by fewer wasted cycles) [E: fundesk.io].

## Numbers worth verifying
- Ticket quality → agent-PR merge: **72% AUC**; verbose desc −9%; external deps −4–9% (arXiv 2512.21426, second-hand) [E].
- Agent-authored PRs on GitHub: **4M (Sep 2025) → 17M (Mar 2026)** [E: agentpatterns.ai].
- Switch-to-Linear breakpoint: **~300–500 open tickets**, ~**15–30 people** [E: cotera, workmanagementhub].
- Pricing: GitHub Team **$4** · Linear **$8** · Jira **$7.75** /user/mo [E].
- Sub-issues: **8 levels**, Projects limit **50,000 items**, tasklists retired **2025-04-30**; `gh` deps in **v2.94.0** (2026-06) [E: github.blog].
- Spec Kit token overhead: **+20–40% per feature** [E: fundesk.io].

## Recommendation for the solo, agent-heavy case (you)
**Go GitHub-native. Don't add Linear.** You are far under the volume ceiling, you already live in GitHub with a
branch-per-unit + `--no-ff` merge discipline (your CLAUDE.md), and your work is Claude-Code-heavy — which is exactly
where `gh` + issues beats Linear/Jira (agent-native credential reuse, issue-as-prompt, worktree-per-issue). It also
extends your existing "config is truth / git is the record of progress" principle: **issues = the durable plan, git =
the execution record.** Linear only earns its $8/seat once you cross ~300 tickets or add a team — revisit then, not now.

Recommended workflow recipe (maps onto your current habits):
1. **Milestones = your handful of important goals** (the anti-drift anchor). One Project (roadmap/hierarchy view) over them.
2. **One epic issue per goal** → decompose into **sub-issues**, each with the WRAP/solo-dev body: what+why · in-scope ·
   **out-of-scope** · definition of done · checklist — and each **links to the `docs/research/` or `docs/design/` doc**
   (you already write these; the issue references them rather than duplicating).
3. **Drive it from `gh` + Claude Code**, one issue at a time: `gh issue view #N` → plan into the issue → `feat/N-…`
   branch → tests → PR (`Closes #N`) → squash-merge. Honor **1-1-1-1-1**.
4. **Consider adopting GitHub Spec Kit** for the front of the funnel — it's the formal version of your PRD flow and its
   `/speckit.taskstoissues` emits the sub-issues for you. Try it on one feature before committing.
5. **If you later want autonomy**, a Baton-style `gh`-polling worktree-per-issue sequencer is the natural piflow-shaped
   extension (issues as the fleet's task queue).

## Next moves
- **One experiment:** migrate the current `ROADMAP.md` into Milestones + a Project, and re-express the next 1–2 goals as
  an epic + sub-issues (each linking its `docs/design/` doc). Run one full issue → PR → close loop with Claude Code via `gh`.
- **One follow-up search if needed:** fetch arXiv **2512.21426** directly (the 72% AUC / WRAP study) before citing it anywhere formal; and pull the Spec Kit repo to gauge real adoption (the "most-adopted SDD tool 2026" claim was unverified).
- **Watch the edge:** keep agent-generated task-lists modest to avoid Copilot abuse limits; adopt an assign-vs-`@mention` convention if you ever run parallel agent sessions.

## Sources
### Reddit [R]
- Jira overkill → hunting Linear/ClickUp; GitHub Projects absent from shortlist — https://www.reddit.com/r/webdev/comments/1p0s3xw/
- Coding-agent "recipe for effective GH issues" (issue body = agent spec) — https://www.reddit.com/r/GithubCopilot/comments/1n386le/
- "Long to-do list in agent mode → banned" (broken edge) — https://www.reddit.com/r/GithubCopilot/comments/1r0wimi/
- Blog CMS built on GitHub Issues (issues-as-primitive) — https://www.reddit.com/r/github/comments/1iknscf/
- "You should really consider dropping sprints" (anti-ceremony) — https://www.reddit.com/r/ExperiencedDevs/comments/1s9np6d/
- Demand for a `gh`-native CLI coding agent — https://www.reddit.com/r/GithubCopilot/comments/1n0igh0/
### Exa [E]
- Issue-driven dev (manage only rich issues) — https://brianchambers.substack.com/p/chamber-of-tech-secrets-55-issue
- Issue tracker as agent dispatch surface (WRAP + 72% AUC) — https://agentpatterns.ai/workflows/issue-tracker-agent-dispatch-surface/
- GitHub Spec Kit (spec-driven dev, `/speckit.*`) — https://github.github.com/spec-kit/
- AI-first workflow: GitHub Issue as planning doc, Claude via `gh` — https://spicermatthews.com/blog/my-new-ai-first-development-workflow-github-issues/
- Copilot + `gh` CLI as a workflow engine — https://dev.to/markring/ai-powered-development-workflows-with-github-copilot-and-the-gh-cli-fde
- Assigning/completing issues with Copilot coding agent — https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/
- Evolving Issues & Projects: sub-issues GA, issue types, advanced search — https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/
- Manage sub-issues/types/dependencies from `gh` CLI (v2.94.0) — https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/
- Hierarchy view in GitHub Projects — https://github.blog/changelog/2026-01-15-hierarchy-view-now-available-in-github-projects/
- Epic-driven development + copilot-auto-queue — https://www.maskaravivek.com/post/epic-driven-development-using-github-copilot/
- Baton: autonomous `gh`-polling Claude Code orchestrator, worktree-per-issue — https://muhammadraza.me/2026/building-baton-autonomous-agent-orchestrator/
- Linear vs Jira vs GitHub Issues 2026 — https://www.stackfyi.com/guides/linear-vs-jira-vs-github-issues-2026
- Linear vs GitHub Issues (500-ticket breakpoint) — https://cotera.co/articles/linear-vs-github-issues-comparison · https://workmanagementhub.com/linear-vs-github-issues-2026/
- 1-1-1-1-1 maintainer policy — https://dmyersturnbull.github.io/ref/maintainer-guide/
- Solo-dev issue template (out-of-scope = most important line) — https://dev.to/southwestmogrown/from-chaos-to-shipped-a-practical-workflow-for-solo-developers-1h9n
- Issue-file-as-spec scope fence — https://zenn.dev/yktsnet/articles/202604-issue-driven-workflow

## Method notes
- Legs run: Reddit (Apify `macrocosmos`) + Exa. YouTube leg skipped per user request. No A/B WebSearch probe.
- Empty/degraded: Reddit site-wide scan couldn't run (the actor defaults to junk subs when `subreddits` omitted); Reddit on-topic hit-rate was low → real signal that this topic is under-posted, debated as Jira-vs-Linear rather than GitHub-native.
- Weakest evidence: the 72% AUC study (cited second-hand) and Spec Kit adoption (claimed, unverified). Everything else is corroborated across ≥2 sources or is first-party GitHub docs.
