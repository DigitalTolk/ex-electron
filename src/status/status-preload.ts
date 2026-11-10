import { ipcRenderer } from 'electron';
import {
  STATUS_CHANGE_SERVER_IPC,
  STATUS_CONTENT_IPC,
  STATUS_RETRY_IPC,
  type StatusContent,
} from '../lib/load-status';

// The status screen shown over the chat window when ex can't open (offline,
// unreachable, blocked by Cloudflare). A local page with no scripts of its
// own: this preload fills it in and wires the buttons. Nothing is exposed to
// the page.

let latest: StatusContent | null = null;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function render(): void {
  if (!latest || document.readyState === 'loading') return;
  for (const icon of document.querySelectorAll<SVGElement>('[data-icon]')) {
    icon.toggleAttribute('hidden', icon.dataset.icon !== latest.icon);
  }
  byId('title').textContent = latest.title;
  byId('message').textContent = latest.message;
  byId('retrying').hidden = !latest.retrying;
  byId('change').hidden = !latest.canChangeServer;
  const detail = byId('detail');
  detail.textContent = latest.detail;
  detail.hidden = !latest.detail;
  const retry = byId<HTMLButtonElement>('retry');
  retry.disabled = false;
  retry.textContent = 'Try again';
}

function retry(): void {
  const button = byId<HTMLButtonElement>('retry');
  if (button) {
    button.disabled = true;
    button.textContent = 'Trying…';
  }
  ipcRenderer.send(STATUS_RETRY_IPC);
}

ipcRenderer.on(STATUS_CONTENT_IPC, (_event, content: StatusContent) => {
  latest = content;
  render();
});

document.addEventListener('DOMContentLoaded', () => {
  byId('retry').addEventListener('click', retry);
  byId('change').addEventListener('click', () => ipcRenderer.send(STATUS_CHANGE_SERVER_IPC));
  render();
});

// Back online: try straight away instead of waiting for the next timed retry.
window.addEventListener('online', retry);
