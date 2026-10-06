import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import * as fs from 'node:fs';
import path from 'node:path';

/** Clear the old Plex-owned limit via the provider, never by rewriting its history. */
export async function clearLegacyPlexCreditLimit(home: string, id: string, cwd: string,
  command: string, token: string, signal: AbortSignal): Promise<void> {
  const manifest = path.join(home, 'plex-conversation.json');
  const identity = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (identity.creditLimitCleared === true) return;
  if (signal.aborted) throw new Error('Plex run cancelled');
  const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_ALLOW_ALL: 'false' };
  delete env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: command,
      args: ['--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user', '--no-remote', '--no-remote-export'] }),
    baseDirectory: home, workingDirectory: cwd, env, gitHubToken: token, useLoggedInUser: false,
  });
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  const stop = (error: Error) => {
    rejectStopped(error);
    void client.forceStop().catch(error => console.error('[plex] Credit-limit migration cleanup failed:', error));
  };
  const abort = () => stop(new Error('Plex run cancelled'));
  const timeout = setTimeout(() => stop(new Error('Timed out clearing the previous Plex credit limit')), 30_000);
  signal.addEventListener('abort', abort, { once: true });
  try {
    await Promise.race([client.start(), stopped]);
    const session = await Promise.race([client.resumeSession(id, {
      continuePendingWork: false, availableTools: [], skipCustomInstructions: true, remoteSession: 'off',
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'Configuration migration does not execute tools' }),
    }), stopped]);
    const result = await Promise.race([session.rpc.options.update({ sessionLimits: null }), stopped]);
    if (!result.success || signal.aborted) throw new Error('Cannot clear the previous Plex session credit limit');
    fs.writeFileSync(manifest, JSON.stringify({ ...identity, creditLimitCleared: true }), { mode: 0o600 });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    const errors = await client.stop();
    if (errors.length) {
      console.error('[plex] Credit-limit migration shutdown failed:', errors);
      await client.forceStop();
    }
  }
}
