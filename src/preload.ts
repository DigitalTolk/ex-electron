import { contextBridge, ipcRenderer } from 'electron';

// Only the setup screen ever talks back to the main process. The chat host
// runs untrusted JavaScript through the BrowserWindow, so we never expose IPC
// there — chat-preload.ts intentionally exposes nothing.
contextBridge.exposeInMainWorld('exDesktop', {
  saveChatUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('settings:saveChatUrl', url),
});

declare global {
  interface Window {
    exDesktop: {
      saveChatUrl: (url: string) => Promise<boolean>;
    };
  }
}
