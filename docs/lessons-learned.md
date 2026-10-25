# Lessons learned

A two-day stabilization and hardening pass, written up as a blameless post-mortem. Times are UTC. Everything described was verified from tool output on the machine, not assumed.

## Why it started

The agent control plane had worked the previous night and then stopped. Chasing that led to a wider security review, because the review kept finding real exposures. The incident and the review are separate problems that happened to share two days.

## Root causes

| # | Symptom | Root cause | How it was shown |
|---|---|---|---|
| 1 | Postgres failed with "could not open shared memory segment" | `systemd-logind` has `RemoveIPC=yes` by default. With lingering off, the service user's IPC objects (including POSIX shared memory in `/dev/shm`) were deleted when their last SSH session closed. The app noticed at its next periodic query. | Journal timeline: session closed, user manager stopped ten seconds later, DB error minutes after |
| 2 | An abnormal DB shutdown after a recoverable fault | A watcher script killed the app whenever 1-minute load exceeded 4. On a 2-core box the load was Postgres crash-loop churn, so the watcher amplified the fault. | Review of the agent's own analysis and the script |
| 3 | OAuth server effectively open to the internet | Dynamic client registration accepted any redirect URI, and the authorize step auto-approved ("single-user"). With the routes public, anyone could register, authorize and receive a bearer token. | Read the source; `tailscale serve status` showed Funnel on |
| 4 | Admin dashboard on the public internet | Funnel mapped `/` to a dashboard started with an insecure flag. A "400 Invalid Host header" is a hostname allowlist, not a login. | `tailscale serve status` |
| 5 | Whole home directory shared read/write | A Samba share rooted at the service account's home exposed private keys, `authorized_keys` and `.env` files. With passwordless sudo on that account, write access to `authorized_keys` is a path to root. | `smb.conf`, share listing |
| 6 | API key in plaintext source | Hard-coded in two source files, inside a repo that was itself shared | Source read |
| 7 | Agent runs always ended `blocked` | The agent was given a web-only toolset, but the platform's completion contract needs a `curl` back to its own API. A terminal is effectively mandatory. | Adapter source and run comments |
| 8 | Would not survive a reboot | Started as a transient `systemd-run` unit | Unit path under `/run/systemd/transient` |
| 9 | Admin account with password-only SSH | Password auth was enabled globally and the account had no key. The heavy login volume turned out to be my own sessions, confirmed. | Auth log review |

Things that looked bad and were not: that login volume, and any evidence of outside use of the MCP server. The journal showed only expected redirect URIs and no tool calls after a restart. But tool logs recorded no client or IP, so that is absence of evidence, and the write-up says so.

## What changed

Every change had a backup first and a rollback written down before it was applied. Chronological, abridged:

1. **Enable lingering** for the service user. This was the real fix for #1. I did not switch Postgres to `mmap` shared memory; it was not needed and adds I/O.
2. **Take a fresh application backup** through the app's own endpoint before touching anything.
3. **Turn Funnel off.** Side effect worth knowing: because every serve entry was funnel-only, this cleared the entire serve config. The old mappings had been saved to a file first, which made rollback possible.
4. **Patch the OAuth server** (see below), build on the desktop, copy only compiled output (no builds on a small box), restart only that service.
5. **Rebuild the Samba config:** remove the whole-home share, replace it with purpose-specific shares, all `read only = yes`, `valid users` set, `hosts allow` limited to specific tailnet devices, `hosts deny = 0.0.0.0/0`, and one identical `veto files` list of 15 entries covering `.ssh`, `.gnupg`, `.env`, `keys`, `*.key`, shell history and similar. Reload, never restart.
6. **Rotate the leaked key** and move it into the environment. Code now reads it lazily, so a missing key fails at call time, not at startup. The old key was dead after rotation, so old copies were quarantined for the owner to delete personally.
7. **Make the app a persistent systemd service** with `Restart=on-failure`, `TimeoutStopSec=120`, `OOMScoreAdjust=200`, `NoNewPrivileges=yes`, `ProtectSystem=full`, and cgroup memory limits ([`examples/paperclip.service`](../examples/paperclip.service)).
8. **Fix the agent toolset** to include a terminal, give it its own working directory, and keep session persistence off on purpose so stale context from an earlier configuration cannot leak into new runs.
9. **SSH policy:** `PasswordAuthentication no` globally, with a `Match Address` block that re-enables it for the tailnet range only. `sshd -t`, then reload ([`examples/sshd-password-policy.conf`](../examples/sshd-password-policy.conf)).
10. **Expose the app on the tailnet only** through `tailscale serve`, then restrict who on the tailnet can reach it with an ACL ([`examples/tailscale-acl.hujson`](../examples/tailscale-acl.hujson)).
11. **Follow-ups, days later:** restrict remote-desktop relay ports to the tailnet interface; set a credential file to mode 600 and add `*-key.txt` to the Samba veto list.

### The OAuth patch

The design point: an OAuth server that approves everything is not authentication, even if the resource server checks bearer tokens. The fix, in order of importance:

1. **Consent requires a secret.** `GET /authorize` renders a form; a code is issued only on a POST that carries the approval secret, compared in constant time.
2. **Redirect allowlist at registration.** One known HTTPS callback plus loopback URLs only, capped count.
3. **Rate limits.** Registrations per hour per IP, a client cap, and a lockout after repeated bad secrets.
4. **Re-validate on submit.** Never trust hidden form fields.
5. **Audit logging.** Every tool call logs tool, client and caller IP (carried through the request with `AsyncLocalStorage`). Token values and the secret are never logged.
6. **Fail closed.** The process exits at startup if the secret is missing or short.

A sketch of items 1 and 6 is in [`examples/consent-gate.ts`](../examples/consent-gate.ts). Testing was a scripted nine-step run against a local copy: evil redirect rejected, valid redirect accepted, authorize shows a consent page with no code, wrong secret returns 401, token exchange without approval returns 400, correct secret yields a code, code yields a token, MCP without a token returns 401, and five bad attempts lock out even the correct secret. What was not tested before deploy was the real third-party connector flow and real proxy headers, and the write-up lists that explicitly.

## Rules I took away

**Operating**
- Facts come from the live box, not memory. Generate a snapshot and trust it over older notes.
- Reads are free; changes need a yes, a backup and a rollback.
- Never print secret values. Report names, lengths and match/no-match.
- Do not kill a service from a load or memory watcher. Cap it with cgroup limits and let the kernel and systemd do their jobs. Alert, do not act.
- Do not build on a small box. Build elsewhere, copy compiled output.
- Keep prompts to the agent short and numbered. Long pasted blocks trigger repetition problems with some models, and typed checksums get mangled. Compare against files.

**Security**
- Tailnet membership is not authorization. Anything with no login (here, a UI controlling shell-capable agents) needs an ACL.
- Verify exposure from outside. A tailnet device proves nothing about public reachability; use a phone on cellular.
- `chmod 600` does not hide files from Samba because it runs as the owning user. Only `veto files` does, and it applies per connection, so reconnect the share to test.
- `testparm -sv` cannot show per-share `veto files`. The config file is the proof; a fresh connection is the runtime check.
- Do not reuse a rollback target blindly. The pre-patch backup of the OAuth server is the open version. Never restore it while the public route is on.
- Treat leaked-then-rotated keys as inert but still clean up copies, and do not edit databases or git history that contain them.
- Tools that give agents a shell need a hard line about what the service account can do: no sudo, `NoNewPrivileges`, `ProtectSystem`, own working directory.

**Agent platforms**
- Check the platform's completion contract before choosing toolsets. A "safe" web-only agent that cannot call back is just a broken agent.
- A comment on a finished issue is a command to its assignee. Ask new questions in new issues.
- Editing an issue (status to `todo`) can wake its agent automatically.
- Do not assume budgets work. In testing, the local adapter reported no cost to the platform, so its budget thresholds would never fire. The real brake was a daily spend limit on the model provider's key.
- Test gates on harmless issues first: human review, approvals, routines, pause/cancel trees. Then give agents real work.
- Unattended cron needs its own conventions. With approvals set to deny, write jobs as allowlisted scripts that create new files, and put a guard line at the top of each prompt job.
- Pause a failing job instead of letting it retry forever. A health-restarter that exited non-zero hundreds of times was worse than none.

**Tooling gotchas**
- SIGTERM from systemd reaches the app and embedded Postgres simultaneously. Postgres exits cleanly and the app logs a noisy "recovery". That is harmless.
- Some admin APIs require a JSON body even when empty. A bare POST returns 400.
- Dashboards may validate the `Host` header and reject a proxied hostname. Use a tunnel instead of editing the public hostname config.
- Antivirus that re-signs TLS can make a valid certificate look broken on one machine. Check another client before blaming the server.

## What I would do differently

- Start with linger and cgroup limits on day one. Both cost nothing and would have prevented the incident.
- Never run an OAuth server in front of a public route without testing the consent path end to end first.
- Put the ACL in before the first device other than the admin's touches the tailnet.
- Add a read-only box report to the daily summary (memory, swap, service state, app health) that only alerts.
- Keep model-provider spend limits in a checklist beside the budget features, since the latter may silently not work.

## Open items at the time of writing

- Decide whether to re-open Funnel for the MCP and OAuth paths only. Only if the web connector is needed, and never for the dashboard.
- Some devices were offline during ACL verification and remain untested.
- The control plane's telemetry setting is still on; decide on it deliberately.
- The `mmap` shared-memory option stays in reserve if segments vanish again with linger enabled.
