import { normalizeChatUrl } from '../lib/url';

const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('url') as HTMLInputElement;
const button = document.getElementById('submit') as HTMLButtonElement;
const err = document.getElementById('err') as HTMLDivElement;

input.focus();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  err.textContent = '';

  const normalized = normalizeChatUrl(input.value);
  if (!normalized) {
    err.textContent = 'Please enter a valid http(s) URL.';
    return;
  }

  button.disabled = true;
  try {
    await window.exDesktop.saveChatUrl(normalized);
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : 'Failed to save URL.';
    button.disabled = false;
  }
});
