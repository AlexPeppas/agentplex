import type { CliTool } from './ipc-channels';

export function conversationIdentity(cli: CliTool | undefined, resumeSessionId: string | null): string {
  const provider = cli === 'copilot-resume' ? 'copilot' : cli === 'claude-resume' ? 'claude' : cli;
  return JSON.stringify([provider, resumeSessionId]);
}
