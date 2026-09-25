import { describe, expect, it } from 'vitest';

import { flattenBackendError } from '../src/runner/backend-error';

describe('flattenBackendError', () => {
  it('hoists the backend writeError shape to flat error/message', () => {
    // Regression: a project_unknown 409 must NOT read as "already has an
    // active task" — the runner keys the retry guidance off these fields.
    const data = flattenBackendError({
      error: { code: 'project_unknown', message: 'task: unknown project — its repositories are needed: "CliffHub"' },
    });
    expect(data.error).toBe('project_unknown');
    expect(data.message).toContain('unknown project');
  });

  it('leaves flat and foreign shapes untouched', () => {
    expect(flattenBackendError({ error: 'task_active', message: 'busy' })).toEqual({
      error: 'task_active',
      message: 'busy',
    });
    expect(flattenBackendError({})).toEqual({});
    expect(flattenBackendError({ error: null, text: 'ok' })).toEqual({ error: null, text: 'ok' });
  });

  it('never overwrites an existing flat message and tolerates partial nests', () => {
    const data = flattenBackendError({ error: { code: 'not_ready', message: 'nested' }, message: 'flat wins' });
    expect(data).toEqual({ error: 'not_ready', message: 'flat wins' });
    // code missing → error object stays as-is; message still hoists.
    const partial = flattenBackendError({ error: { message: 'only text' } });
    expect(partial.error).toEqual({ message: 'only text' });
    expect(partial.message).toBe('only text');
  });
});
