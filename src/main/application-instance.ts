import type { App } from 'electron';
import * as path from 'node:path';

export function claimApplicationInstance(app: App, focusOwner: () => void): boolean {
  // Dev and packaged entrypoints share both restore state and the native app lock.
  app.setName('AgentPlex');
  app.setPath('userData', path.join(app.getPath('appData'), 'AgentPlex'));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    app.whenReady().then(focusOwner).catch(error => {
      console.error('[instance] Failed to focus the existing application:', error);
    });
  });
  return true;
}
