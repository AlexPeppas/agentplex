import { X } from 'lucide-react';
import { usePlexStore } from '../plex-store';
import { PlexWorkerTranscript } from './PlexWorkerTranscript';

export function PlexWorkerChat() {
  const { workspace, workerView, closeWorker } = usePlexStore();
  if (!workerView) return null;
  const { conversationId, agentId } = workerView;
  const state = workspace?.states[conversationId];
  const agent = state?.agents.find(agent => agent.id === agentId);
  if (!agent) return null;
  const activity = state?.tasks.filter(task => task.assignedAgentId === agentId)
    .flatMap(task => task.activity ?? []) ?? [];
  return <aside aria-label="Worker chat" className="w-[440px] max-w-[80vw] shrink-0 h-full min-h-0 flex flex-col bg-surface border-l border-border text-fg">
    <header className="flex items-center gap-2 p-3 border-b border-border">
      <strong className="flex-1">{agent.name} · read-only</strong>
      <button aria-label="Close worker chat" onClick={closeWorker}><X size={16} /></button>
    </header>
    <p className="p-3 text-xs text-fg-muted break-all">{state?.mount?.cwd}<br />
      {agent.model ?? 'CLI default'} · {agent.status} · {conversationId.slice(0, 8)}
    </p>
    <div className="flex-1 min-h-0 flex flex-col p-3">
      {state?.questions?.filter(question => question.workerId === agentId).map(question => <details key={question.id}
        className="text-xs p-2 border border-border rounded">
        <summary>Question to Plex: {question.status}</summary>
        <p className="whitespace-pre-wrap">{question.question}</p>
        {question.answer && <p className="whitespace-pre-wrap">{question.answeredBy}: {question.answer}</p>}
        {question.reason && <p>{question.reason}</p>}
      </details>)}
      <PlexWorkerTranscript key={`${conversationId}:${agentId}`} conversationId={conversationId}
        agentId={agentId} activity={activity} />
    </div>
  </aside>;
}
