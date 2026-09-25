import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Electron entrypoints exercise BrowserWindow/ipcMain/Tray and aren't
      // unit-testable without a full Electron harness. Coverage is gated to
      // the pure helpers in src/lib + the page-side notification override.
      exclude: [
        'src/main.ts',
        'src/preload.ts',
        'src/chat-preload.ts',
        'src/setup/setup.ts',
        // Runner process wiring: these spawn and drive real child processes
        // (`claude -p`, codex, the MCP stdio server) or hold the runner's
        // network main loop, and mocking that machinery end-to-end buys no
        // confidence — the LOGIC they orchestrate is extracted into the
        // covered modules (task-policy, sessions, connectors, connector-docs,
        // spill, describe-tool, run-status, workspace helpers). Exclusion
        // agreed with Günter, 2026-09-22.
        'src/runner/index.ts',
        'src/runner/run.ts',
        'src/runner/mcp-server.ts',
        'src/runner/detect.ts',
        'src/runner/harness/claude.ts',
        'src/runner/harness/codex.ts',
        'src/runner/harness/bedrock.ts',
        // Electron-main runner host: app lifecycle + safeStorage keychain.
        'src/lib/runner-host.ts',
      ],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
