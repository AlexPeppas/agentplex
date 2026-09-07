import { SessionStatus } from '../shared/ipc-channels';

/** Copilot assistant turns span model reasoning and synchronous tool execution.
 * model.* events also describe background calls and are not session boundaries. */
export class CopilotLifecycle {
  private turns = new Set<string>();
  private tools = new Map<string, { turnId: string; question: boolean }>();
  private permissions = new Map<string, string | undefined>();

  get status(): SessionStatus {
    if (this.permissions.size || [...this.tools.values()].some(tool => tool.question)) {
      return SessionStatus.WaitingForInput;
    }
    return this.turns.size || this.tools.size ? SessionStatus.Running : SessionStatus.Idle;
  }

  reset(): void {
    this.turns.clear();
    this.tools.clear();
    this.permissions.clear();
  }

  accept(record: { type?: unknown; data?: unknown }): void {
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const rawTurnId = 'turnId' in data ? data.turnId : undefined;
    const hasTurnId = typeof rawTurnId === 'string';
    const turnId = hasTurnId ? rawTurnId : 'current';
    const toolCallId = 'toolCallId' in data && typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
    const requestId = 'requestId' in data && typeof data.requestId === 'string' ? data.requestId : undefined;

    switch (record.type) {
      case 'session.start':
      case 'session.resume':
      case 'session.idle':
      case 'session.shutdown':
      case 'abort':
        this.reset();
        break;
      case 'session.error':
        // Query failures terminate an interaction; unrelated warnings/errors
        // must not interrupt a still-running assistant turn.
        if ('errorType' in data && data.errorType === 'query') this.reset();
        break;
      case 'user.message':
        // A queued message does not resolve a pending permission or question.
        if (!this.turns.size) this.turns.add('pending');
        break;
      case 'assistant.turn_start':
      case 'assistant.message':
        this.turns.delete('pending');
        // Older message records omit turnId; do not invent a second active
        // turn when the matching turn_start already supplied its identity.
        if (hasTurnId || !this.turns.size) this.turns.add(turnId);
        break;
      case 'assistant.turn_end':
        if (!hasTurnId) {
          this.reset();
          break;
        }
        this.turns.delete(turnId);
        this.turns.delete('current');
        this.turns.delete('pending');
        if (!this.turns.size) {
          // Also discard unanswered requests from a completed/cancelled turn.
          this.reset();
        } else {
          for (const [id, tool] of this.tools) {
            if (tool.turnId === turnId) this.completeTool(id);
          }
        }
        break;
      case 'tool.execution_start':
        if (toolCallId) {
          this.tools.set(toolCallId, {
            turnId,
            question: 'toolName' in data && data.toolName === 'ask_user',
          });
        }
        break;
      case 'tool.execution_complete':
        if (toolCallId) this.completeTool(toolCallId);
        break;
      case 'permission.requested': {
        if (!requestId) break;
        const request = 'permissionRequest' in data ? data.permissionRequest : undefined;
        const owner = request && typeof request === 'object' && 'toolCallId' in request
          && typeof request.toolCallId === 'string' ? request.toolCallId : toolCallId;
        this.permissions.set(requestId, owner);
        break;
      }
      case 'permission.completed':
        if (requestId) this.permissions.delete(requestId);
        break;
    }
  }

  private completeTool(toolCallId: string): void {
    this.tools.delete(toolCallId);
    // A completed tool cannot still be blocked on its permission, even if a
    // provider version omits the corresponding permission.completed record.
    for (const [id, owner] of this.permissions) {
      if (owner === toolCallId) this.permissions.delete(id);
    }
  }
}
