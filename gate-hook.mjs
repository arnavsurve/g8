#!/usr/bin/env node
// gate-hook.mjs — Claude Code PreToolUse hook.
// Reads the hook payload from stdin, loads policies.json, sends the tool call
// plus conversation context to TypeSafe.ai's Jev System One API for a single
// `choice` question: which policy (if any) does this call violate, or allow?
// Prints a PreToolUse hook JSON decision on stdout.
//
// Fail-open on infrastructure errors (API down/timeout): log to stderr and
// allow, so the hook never wedges the user's session. Policies are enforced
// only when Jev actually answers.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const AUDIT_LOG = process.env.GATE_AUDIT_LOG ?? path.join(process.env.HOME ?? "", ".g8", "audit.jsonl");
const MODEL = "jev-latest";
const TIMEOUT_MS = 25_000;
const ALLOW = { allow: "The call is compliant with every policy." };

const { JEV_ENDPOINT, JEV_MODEL, GATE_TIMEOUT_MS } = process.env;
const endpoint = JEV_ENDPOINT || ENDPOINT;
const model = JEV_MODEL || MODEL;

// ---------- config discovery: policies.json lives next to this script, or ../../ for plugins ----------
function findPolicies() {
  const candidates = [
    process.env.GATE_POLICIES,
    path.join(import.meta.dirname, "policies.json"),
    path.join(import.meta.dirname, "..", "policies.json"),
    path.join(import.meta.dirname, "..", "..", "policies.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  return null;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ---------- conversation context from the transcript ----------
// PreToolUse payload has `transcript_path`. Grab the last N messages, keep it
// short: the classifier needs intent (what did the user ask for), not history.
function loadContext(transcriptPath, maxMessages = 12, budget = 6000) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    const msgs = [];
    for (const line of lines.reverse()) {
      if (msgs.length >= maxMessages || msgs.join("\n").length >= budget) break;
      try {
        const e = JSON.parse(line);
        const role = e.type === "user" ? "user" : e.type === "assistant" ? "assistant" : null;
        if (!role) continue;
        let text = "";
        if (typeof e.message?.content === "string") text = e.message.content;
        else if (Array.isArray(e.message?.content))
          text = e.message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(" ");
        if (text.trim()) msgs.unshift(`${role}: ${text.trim().slice(0, 800)}`);
      } catch {
        /* skip malformed lines */
      }
    }
    return msgs.join("\n\n").slice(0, budget);
  } catch {
    return "";
  }
}

// ---------- summarize the tool call ----------
function describeTool(payload) {
  const { tool_name, tool_input } = payload;
  let input = tool_input ?? {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = { raw: input };
    }
  }
  return { tool: tool_name, input };
}

// ---------- the classification ----------
async function classify(state) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer sentinel", "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      state,
      questions: {
        verdict: {
          type: "choice",
          instructions:
            "You are a security policy gate for an AI coding agent. A tool call is about to execute. Decide which policy (if any) the call violates. If the call violates no policy, choose allow. Judge intent from the full context, not just keywords.",
          criteria: { ...ALLOW, ...Object.fromEntries(policies.map((p) => [p.id, `VIOLATES: ${p.description}`])) },
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  const a = data?.answers?.verdict;
  if (!a) throw new Error(`jev gave no verdict: ${JSON.stringify(data).slice(0, 200)}`);
  return a; // {choice, confidence}
}

// ---------- audit log ----------
import { mkdirSync, appendFileSync } from "node:fs";
function audit(record) {
  try {
    mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
  } catch {
    /* never block on audit failure */
  }
}

// ---------- main ----------
let payload;
try {
  payload = JSON.parse(readStdin() || "{}");
} catch (e) {
  console.error("gate-hook: bad hook payload, allowing:", e.message);
  process.exit(0);
}

const policiesCfg = findPolicies();
if (!policiesCfg) {
  console.error("gate-hook: no policies.json found, allowing");
  process.exit(0);
}
const policies = policiesCfg.policies ?? [];
if (policies.length === 0 || policies.length > 250) {
  console.error("gate-hook: policies.json must have 1-250 policies, allowing");
  process.exit(0);
}

const state = {
  policies: policies.map(({ id, description }) => ({ id, description })),
  conversation_context: loadContext(payload.transcript_path),
  tool_call: describeTool(payload),
  cwd: payload.cwd,
};

let answer;
try {
  answer = await classify(state);
} catch (e) {
  audit({ event: "error", tool: payload.tool_name, error: e.message });
  if (process.env.GATE_FAIL_CLOSED === "1") {
    console.log(JSON.stringify({ decision: "block", reason: "policy gate unavailable (GATE_FAIL_CLOSED)" }));
  }
  console.error(`gate-hook: classifier unavailable. ${e.message}`);
  process.exit(process.env.GATE_FAIL_CLOSED === "1" ? 0 : 0);
}

audit({ event: answer.choice === "allow" ? "allow" : "block", tool: payload.tool_name, input: state.tool_call.input, policy: answer.choice, confidence: answer.confidence });

if (answer.choice !== "allow") {
  const pol = policies.find((p) => p.id === answer.choice);
  const conf = answer.confidence != null ? ` (confidence ${Math.round(answer.confidence * 100)}%)` : "";
  console.log(
    JSON.stringify({
      decision: "block",
      reason: `Blocked by policy gate [${answer.choice}]${conf}: ${pol?.description ?? answer.choice}`,
    })
  );
  process.exit(0);
}
process.exit(0); // allow: exit 0 with no decision JSON
