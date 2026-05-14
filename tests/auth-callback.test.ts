import { describe, expect, it } from 'vitest';
import { AUTH_CALLBACK_HTML } from '../src/lib/auth-callback';

describe('AUTH_CALLBACK_HTML', () => {
  it('is a complete HTML document', () => {
    expect(AUTH_CALLBACK_HTML).toMatch(/^<!doctype html>/i);
    expect(AUTH_CALLBACK_HTML).toContain('<title>Signed in</title>');
  });

  it('renders the user-facing message', () => {
    expect(AUTH_CALLBACK_HTML).toContain('Signed in');
    expect(AUTH_CALLBACK_HTML).toContain('You can close this tab');
  });

  it('attempts to close the browser tab via script', () => {
    expect(AUTH_CALLBACK_HTML).toContain('window.close()');
  });
});
