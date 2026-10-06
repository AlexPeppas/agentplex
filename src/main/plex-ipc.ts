import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { PLEX_IPC } from '../shared/plex';
import { PlexHarness } from './plex-harness';
import { runPlexCli } from './plex-cli';
import { listPlexModels } from './plex-models';

export function registerPlexHandlers() {
  let harness: PlexHarness | undefined;
  const get = () => harness ??= new PlexHarness(path.join(app.getPath('home'), '.agentplex', 'plex'), runPlexCli, workspace => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(PLEX_IPC.changed, workspace);
    }
  });
  ipcMain.handle(PLEX_IPC.workspace, () => get().snapshot());
  ipcMain.handle(PLEX_IPC.models, () => listPlexModels());
  ipcMain.handle(PLEX_IPC.transcript, (_event, conversationId: unknown, agentId: unknown) =>
    get().transcript(conversationId, agentId));
  ipcMain.handle(PLEX_IPC.createConversation, (_event, cwd: unknown, blueprintId: unknown, requestId: unknown) =>
    get().createConversation(cwd, blueprintId, requestId));
  ipcMain.handle(PLEX_IPC.saveBlueprint, (_event, blueprint: unknown) => get().saveBlueprint(blueprint));
  ipcMain.handle(PLEX_IPC.deleteBlueprint, (_event, id: unknown) => get().deleteBlueprint(id));
  ipcMain.handle(PLEX_IPC.chat, (_event, message: unknown, conversationId: unknown, messageId: unknown) =>
    get().chat(conversationId, messageId, message));
  ipcMain.handle(PLEX_IPC.approve, (_event, conversationId: unknown, approvalId: unknown) =>
    get().approve(conversationId, approvalId));
  ipcMain.handle(PLEX_IPC.cancel, (_event, conversationId: unknown, approvalId: unknown) =>
    get().cancel(conversationId, approvalId));
  ipcMain.handle(PLEX_IPC.permissionDecision, (_event, conversationId: unknown, jobId: unknown, requestId: unknown, decision: unknown) =>
    get().decidePermission(conversationId, jobId, requestId, decision));
  ipcMain.handle(PLEX_IPC.answerQuestion, (_event, conversationId: unknown, questionId: unknown, answer: unknown) =>
    get().answerQuestion(conversationId, questionId, answer));
  app.on('before-quit', () => harness?.dispose());
}
