// setRunStatus sets the run's visible status emoji (the reaction on the
// invoking message) straight from the runner, over the same run-token
// endpoint the set_state MCP tool uses. The ⚙️ "working" status used to be
// the agent's FIRST tool call on every run — a whole model turn, plus one
// re-read of the entire context, spent on a status emoji. The runner knows
// exactly when the harness starts, so it sets it directly. Best-effort: a
// failure here never affects the run.
export async function setRunStatus(baseUrl: string, runToken: string, state: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/agent/run/state`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error(`set status failed: ${res.status}`);
}
