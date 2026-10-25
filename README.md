# hermes-agent-ops

Operations notes from running a self-hosted AI agent stack on a single small VPS: what the system looks like, how it was hardened after a real incident, and what I would tell someone about to do the same.

This is a documentation repo. It contains no deployable infrastructure, no credentials and no real hostnames. Everything that identifies the machine, the network or the people involved has been replaced with placeholders such as `<VPS_IP>` and `<TAILNET>`.

## The problem

I wanted a few AI agents doing useful recurring work without paying for a managed platform and without handing a vendor my data. The target was one low-cost VPS (2 vCPU, under 4 GB of RAM, 4 GB of swap) running:

- **Hermes**, a self-hosted agent runtime that connects to chat apps, runs scheduled (cron-style) jobs, and exposes its tools to other clients over an MCP server.
- **Paperclip**, an open-source control plane that models a small "company" of agents: roles, issues, review gates, routines and budgets. Its agents run on top of Hermes.

It worked until it did not. A database crash, an apparently unrelated stability problem, and then a security review that found several real exposures. Fixing those, and writing down why they happened, is the substance of this repo.

## What is in here

| File | Purpose |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Components, trust boundaries, network exposure, and a Mermaid diagram |
| [`docs/lessons-learned.md`](docs/lessons-learned.md) | Root causes, the hardening changes, and the rules I now follow |
| [`examples/`](examples) | Sanitized configs and snippets, included only where they teach something |

## What this demonstrates

**Self-hosted agent orchestration.** Hermes provides the runtime and tool surface. Paperclip layers a work model on top: a CEO agent that plans and delegates, specialist agents (research, drafting, QA), parent/child issues, and execution policies. The interesting part is not the agents, it is the controls around them. A `human_only` review stage means an agent can finish its work but cannot pass the gate that releases it. I tested that gate, plus approvals, routines, and pause/cancel of a whole issue tree, on harmless test issues before giving any agent real work.

**Cron-driven jobs.** Scheduled jobs run unattended under a policy that denies approval prompts. That policy blocks heredocs, inline interpreters and overwriting existing files, which is the right default but means every job has to be written for it: allowlisted scripts, new files instead of overwrites, and a guard line at the top of each prompt job saying so. Jobs that fail repeatedly get paused rather than retried forever.

**VPS hardening.** A structured review found and fixed: an OAuth server that approved every client automatically while exposed to the public internet; a file share that exposed an entire home directory including SSH keys; a hard-coded API key in source; password-only SSH; and a service that would not survive a reboot. Each change had a backup and a stated rollback before it was applied.

**Paperclip in production-ish conditions.** Running it as a persistent systemd unit with memory caps (`MemoryHigh`/`MemoryMax`/`MemorySwapMax`), `Restart=on-failure`, `NoNewPrivileges` and `ProtectSystem`, sized by measuring peak usage with two agents running at once rather than guessing.

## The short version of what went wrong

1. **A database crash with no OOM in the logs.** The cause was `systemd-logind` removing a user's shared-memory objects when their last SSH session ended (`RemoveIPC` plus no lingering). Postgres lost its segment from under it. Fix: `loginctl enable-linger`.
2. **A watcher that made it worse.** A script killed the app whenever load went above a threshold, on a 2-core box where the load was Postgres churn. Fix: cap with cgroup limits and never kill from a watcher.
3. **An OAuth server that was not authentication.** Open dynamic registration plus auto-approve consent meant any internet client could obtain a bearer token. Fix: consent page gated by a secret, redirect allowlist, rate limits, audit logging, fail-closed startup.
4. **Public exposure by default.** A Tailscale Funnel configuration published the agent dashboard and OAuth endpoints. Fix: Funnel off, tailnet-only serve, ACL restricting the one unauthenticated UI to personal devices.

Details, evidence and the full list are in [`docs/lessons-learned.md`](docs/lessons-learned.md).

## Method

A few habits shaped how the work went, and I would keep them on any similar project:

- **Facts come from the live machine.** A read-only refresh script writes a state snapshot; I trust it over any older note.
- **Reads are free, changes are not.** Every change needs approval, a backup first, and a written rollback.
- **Never print secret values.** Lengths and match/no-match only.
- **Verify from outside.** Closing a public route was confirmed from a phone on cellular, because a tailnet device proves nothing about public exposure.
- **Absence of evidence is not proof.** Where logs could not show who called a tool, the write-up says so rather than declaring the system clean.

## What is deliberately left out

Any business, client or personal detail. Hostnames, addresses, usernames, device names, key material, scheduled-job payloads and the contents of the agents' working files. The architecture and the security lessons stand on their own without them.

## License

MIT. See [`LICENSE`](LICENSE).
