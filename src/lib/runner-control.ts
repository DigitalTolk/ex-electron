// Bridge for the chat SPA's `window.__EX_RUNNER__` contract (the ex repo's
// src/types/global.d.ts and src/lib/desktop-runner.ts): the Runners tab asks
// the app to install, connect, start and stop ex-runner, and the app pushes
// the runner's state back. RunnerManager (main process) does the work.
//
// Crossing the world boundary works like the other bridges: the chat window
// exposes NO contextBridge surface, so requests, results and state travel as
// JSON strings stamped on shared <html> attributes, signalled by PLAIN Events
// (CustomEvent detail does not survive the isolated-world boundary). Requests
// carry an id, so a getState can be answered while an install is still
// running.
//
//   page (main world)               preload (isolated world)          main
//   __EX_RUNNER__.call(op, arg)
//     stamp req attr + Event ─────▶ read+clear ─ipc invoke──────────▶ RunnerManager.handle
//     promise pends by id
//     read+clear result attr ◀───── stamp result attr + Event ◀──────── { ok, value | error }
//   subscribe(listener) ◀────────── stamp state attr + Event ◀──────── state push (ipc send)

export const RUNNER_REQUEST_EVENT = 'ex:runner-request';
export const RUNNER_REQUEST_ATTR = 'data-ex-runner-request';
export const RUNNER_RESULT_EVENT = 'ex:runner-result';
export const RUNNER_RESULT_ATTR = 'data-ex-runner-result';
export const RUNNER_STATE_EVENT = 'ex:runner-state';
export const RUNNER_STATE_ATTR = 'data-ex-runner-state';
export const RUNNER_CONTROL_IPC = 'runner:control'; // preload → main (invoke)
export const RUNNER_STATE_IPC = 'runner:state'; // main → preload (send)

// Installing downloads a release and connecting waits for a person: the
// main process owns the real limits, the page backstop only covers a
// torn-down shell that never answers.
export const RUNNER_PAGE_TIMEOUT_MS = 15 * 60_000;

export interface RunnerControlRequest {
  id: number;
  op: string;
  arg?: unknown;
}

export type RunnerControlResult = { ok: true; value: unknown } | { ok: false; error: string };

// Page-side source, injected into the main world via webFrame.executeJavaScript.
export const RUNNER_CONTROL_BRIDGE_SOURCE = `(() => {
  if (window.__EX_RUNNER__) return;
  const root = document.documentElement;
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  document.addEventListener('${RUNNER_RESULT_EVENT}', () => {
    const raw = root.getAttribute('${RUNNER_RESULT_ATTR}');
    root.removeAttribute('${RUNNER_RESULT_ATTR}');
    let res = null;
    try {
      res = JSON.parse(raw || '');
    } catch {
      return;
    }
    const p = res && pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok === true) p.resolve(res.value);
    else p.reject(new Error(typeof res.error === 'string' && res.error ? res.error : 'ex-runner action failed'));
  });
  document.addEventListener('${RUNNER_STATE_EVENT}', () => {
    const raw = root.getAttribute('${RUNNER_STATE_ATTR}');
    root.removeAttribute('${RUNNER_STATE_ATTR}');
    let state = null;
    try {
      state = JSON.parse(raw || '');
    } catch {
      return;
    }
    for (const l of [...listeners]) {
      try {
        l(state);
      } catch {
        // one listener's failure must not starve the others
      }
    }
  });
  window.__EX_RUNNER__ = {
    call: (op, arg) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the ex app did not answer'));
      }, ${RUNNER_PAGE_TIMEOUT_MS});
      pending.set(id, { resolve, reject, timer });
      try {
        root.setAttribute('${RUNNER_REQUEST_ATTR}', JSON.stringify({ id, op: String(op), arg: arg === undefined ? null : arg }));
        document.dispatchEvent(new Event('${RUNNER_REQUEST_EVENT}'));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('ex-runner action failed'));
      }
    }),
    subscribe: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();`;

// installRunnerControlAnswerer wires the preload (isolated-world) half: each
// page request goes to main, whatever comes back is stamped for the page,
// and every state push from main is relayed to the page's subscribers. An
// invoke that itself fails (a killed main) still answers.
export function installRunnerControlAnswerer(
  doc: Document,
  invoke: (op: string, arg: unknown) => Promise<RunnerControlResult>,
  onState: (relay: (state: unknown) => void) => void,
): void {
  const stamp = (attr: string, event: string, value: unknown) => {
    try {
      doc.documentElement.setAttribute(attr, JSON.stringify(value));
      doc.dispatchEvent(new Event(event));
    } catch {
      // The page tore down; nothing left to answer into.
    }
  };
  doc.addEventListener(RUNNER_REQUEST_EVENT, () => {
    const raw = doc.documentElement.getAttribute(RUNNER_REQUEST_ATTR);
    doc.documentElement.removeAttribute(RUNNER_REQUEST_ATTR);
    let req: RunnerControlRequest;
    try {
      req = JSON.parse(raw ?? '') as RunnerControlRequest;
    } catch {
      return;
    }
    if (!req || typeof req.id !== 'number' || typeof req.op !== 'string') return;
    const answer = (res: RunnerControlResult) => stamp(RUNNER_RESULT_ATTR, RUNNER_RESULT_EVENT, { id: req.id, ...res });
    invoke(req.op, req.arg).then(
      (res) => answer(res && typeof res === 'object' ? res : { ok: false, error: 'ex-runner action failed' }),
      (err: unknown) => answer({ ok: false, error: err instanceof Error ? err.message : 'ex-runner action failed' }),
    );
  });
  onState((state) => stamp(RUNNER_STATE_ATTR, RUNNER_STATE_EVENT, state));
}
