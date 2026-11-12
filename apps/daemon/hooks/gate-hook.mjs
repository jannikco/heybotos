#!/usr/bin/env node
// PreToolUse hook for HeyBotOS workers. Asks the daemon whether a shell command or connector call may
// run. Anything other than a clear "allow" stops the call: a daemon that is down, a bad answer, a
// timeout. Plain JavaScript with no dependencies, because it starts once per tool call.
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  process.exit(0)
}

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

const { HEYBOTOS_GATE_URL: url, HEYBOTOS_GATE_TOKEN: token, HEYBOTOS_RUN_ID: runId } = process.env
if (!url || !token || !runId) deny('HeyBotOS: this worker was started without its gate settings, so the action was not allowed.')

let call
try {
  call = JSON.parse(raw)
} catch {
  deny('HeyBotOS: could not read the tool call, so it was not allowed.')
}

try {
  const res = await fetch(`${url}/api/gate/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-heybotos-gate': `${runId}:${token}` },
    body: JSON.stringify({ tool: call.tool_name, input: call.tool_input ?? {} }),
    signal: AbortSignal.timeout(10_000),
  })
  const answer = await res.json()
  if (res.ok && answer.decision === 'allow') process.exit(0)
  deny(answer.reason || 'HeyBotOS: the gate did not allow this.')
} catch {
  deny('HeyBotOS: the HeyBotOS daemon is not answering, so shell commands and connector calls are paused. Stop here and hand in your report with status blocked.')
}
