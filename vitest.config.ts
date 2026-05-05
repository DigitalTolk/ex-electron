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
      ],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
