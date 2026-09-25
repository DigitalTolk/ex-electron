// Bridge for the agent-runner token handoff (plan-v2 §3): the SPA — which
// holds a valid interactive session — mints the runner-scoped token via
// POST /api/v1/agents/runner-token and hands it to the shell. The shell
// NEVER mints it itself: doing that through the refresh flow would rotate
// the refresh cookie in the shared persist:ex-chat jar and race the SPA's
// own refresh into a logout.
//
// Same shared-DOM crossing as the DnD bridge (values don't reliably cross
// the isolated-world boundary; the DOM does):
//
//   page (main world)                preload (isolated world)         main
//   __EX_AGENT_RUNNER__.provideToken ─┐
//     stamps data-ex-runner-token     ├─token evt──▶ listener reads + ──ipc──▶ startRunner
//     dispatches token event ─────────┘             clears the attribute
//
// The attribute is cleared immediately after the read so the token never
// lingers in the DOM. Trust note: the page is our own SPA from the
// configured server; the worst hostile page code can do is hand a token the
// backend rejects (the runner stops on 401 rather than spinning).

export const RUNNER_TOKEN_EVENT = 'ex:runner-token';
export const RUNNER_TOKEN_ATTR = 'data-ex-runner-token';
export const RUNNER_TOKEN_IPC_CHANNEL = 'runner:token';

// Page-side source, injected into the main world via
// webFrame.executeJavaScript. The SPA detects the marker and calls
// window.__EX_AGENT_RUNNER__.provideToken(token) after minting.
export const RUNNER_BRIDGE_SOURCE = `(() => {
  if (window.__EX_AGENT_RUNNER__) return;
  window.__EX_AGENT_RUNNER__ = {
    provideToken: (token) => {
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return;
      document.documentElement.setAttribute('${RUNNER_TOKEN_ATTR}', token);
      document.dispatchEvent(new Event('${RUNNER_TOKEN_EVENT}'));
    },
  };
})();`;

// installRunnerTokenListener wires the preload half: read the stamped token,
// scrub it from the DOM, forward it to main over IPC.
export function installRunnerTokenListener(
  doc: Document,
  send: (token: string) => void,
): void {
  doc.addEventListener(RUNNER_TOKEN_EVENT, () => {
    const token = doc.documentElement.getAttribute(RUNNER_TOKEN_ATTR);
    doc.documentElement.removeAttribute(RUNNER_TOKEN_ATTR);
    if (token) send(token);
  });
}
