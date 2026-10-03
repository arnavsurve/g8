# ToolGate

A policy gate for Claude Code: every tool call is checked against a JSON list
of plain-English policies by an LLM classifier (TypeSafe.ai Jev System One) and
blocked before execution if it violates one. No human in the loop — no
approval prompts, no permission dialogs.

## How it works

1. Claude Code fires the `PreToolUse` hook for every tool call.
2. `gate-hook.mjs` reads the hook payload (tool name, arguments, transcript
   path, cwd), pulls the last few conversation messages as context.
3. It sends one request to `https://api.typesafe.ai/v1/systemone` with:
   - `state`: `{ policies, conversation_context, tool_call, cwd }`
   - `questions`: a single `choice` question whose options are
     `allow` + each policy id.
4. A non-`allow` answer returns `{"decision":"block","reason":...}` to Claude
   Code, which refuses the tool call and sees the policy it violated.
5. Every decision (allow, block, error) is appended to `~/.toolgate/audit.jsonl`.

Latency: ~0.4s per decision. Fail-open on classifier errors by default
(`GATE_FAIL_CLOSED=1` to invert).

## Install into Claude Code

Option A — settings.json (manual):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command",
          "command": "node /path/to/toolgate/gate-hook.mjs" } ] }
    ]
  }
}
```

Option B — plugin: drop the `plugin/` directory into `~/.claude/plugins/`
and enable it. Policies are read from `policies.json` next to the hook script
(or set `GATE_POLICIES=/path/to/policies.json`).

## Writing policies

`policies.json` is a list of `{id, description}` where `description` is a
plain-English rule. The classifier is told: "choose which policy (if any) this
call violates." One id must be `allow`-behavior-free — the script injects an
`allow` option automatically. Max 250 policies (API choice limit is 255).

## What policy idioms are proven (Oct 2026)

Verified against real API responses with conversation context:

- Exfiltration of env/secrets (incl. base64-wrapped) → blocked
- Destructive shell (`sudo rm -rf /etc`, reboot) → blocked
- Local env reads (`echo $PATH`), recon (`whoami`), normal dev commands → allowed
- `git push` to feature branch → allowed (and it respects "no pushes to main"
  style policies via the policy text)

## Open issues / next steps

- Latency is fine, but the API has no documented SLA; a batched second opinion
  or a cheap local pre-filter (exact-match allowlist) could cut most calls.
- Context is currently transcript-tail only. Provenance-aware (taint-tracking)
  policies are the natural v2.
- Supports one policy set globally; per-project policies via
  `policies.json` in the project dir would be trivial.
