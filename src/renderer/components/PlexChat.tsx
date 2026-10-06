import { useEffect, useRef, useState } from 'react';
import { Bot, X } from 'lucide-react';
import type { PlexWorkspace } from '../../shared/plex';
import { usePlexStore } from '../plex-store';
import { useAppStore } from '../store';
import { PlexMascot } from './PlexMascot';

export function PlexChat() {
  const { workspace, selectedId, state, open, error, setWorkspace, selectConversation, setOpen, setError } = usePlexStore();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState<Set<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [blueprintId, setBlueprintId] = useState('');
  const [mounting, setMounting] = useState(false);
  const [requests, setRequests] = useState<Record<string, { id: string; text: string }>>({});
  const feed = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { follow.current = true; }, [selectedId]);
  useEffect(() => {
    if (feed.current && follow.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [state, selectedId]);
  useEffect(() => {
    let mounted = true;
    let received = false;
    const unsubscribe = window.agentPlex.onPlexChanged(next => {
      received = true;
      if (mounted) setWorkspace(next);
    });
    window.agentPlex.plexWorkspace().then(next => {
      if (mounted && !received) setWorkspace(next);
    }).catch(error => { if (mounted) setError(String(error)); });
    return () => { mounted = false; unsubscribe(); };
  }, [setWorkspace, setError]);

  if (!open) return null;
  const welcome = !selectedId || state?.messages.length === 0;
  const busy = !!selectedId && (sending.has(selectedId) || !!state?.brainBusy ||
    ['planning', 'summarizing'].includes(state?.phase ?? ''));
  const working = ['running', 'waiting-for-approval'].includes(state?.phase ?? '');
  const approval = state?.phase === 'awaiting-approval';
  const run = async (id: string, operation: () => Promise<PlexWorkspace>) => {
    setPending(previous => new Set(previous).add(id));
    setError(null);
    try { setWorkspace(await operation()); return true; }
    catch (error) {
      if (usePlexStore.getState().selectedId === id) setError(String(error));
      else console.error('[plex] background conversation request failed:', error);
      return false;
    } finally { setPending(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  };
  const send = async (id: string, text: string, messageId: string) => {
    setSending(previous => new Set(previous).add(id));
    setRequests(previous => ({ ...previous, [id]: { text, id: messageId } }));
    try {
      if (await run(id, () => window.agentPlex.plexChat(text, id, messageId))) {
        setRequests(previous => { const next = { ...previous }; delete next[id]; return next; });
        setDrafts(previous => ({ ...previous, [id]: '' }));
      }
    } finally {
      setSending(previous => { const next = new Set(previous); next.delete(id); return next; });
    }
  };
  return <aside className="w-[440px] max-w-[80vw] shrink-0 h-full min-h-0 flex flex-col bg-surface border-l border-border text-fg" aria-label="Plex chat">
    <header className="flex items-center gap-2 p-3 border-b border-border">
      {welcome ? <Bot size={18} className="text-accent" /> : <PlexMascot compact />}<strong className="flex-1">Plex</strong>
      <button className="text-xs text-accent" onClick={() => selectConversation(null)}>New chat</button>
      <button onClick={() => setOpen(false)} aria-label="Close Plex chat"><X size={16} /></button>
    </header>
    <div className="p-3 space-y-2 border-b border-border text-xs">
      <select aria-label="Plex conversation" className="w-full bg-elevated rounded p-2" value={selectedId ?? ''}
        onChange={event => selectConversation(event.target.value || null)}>
        <option value="">New conversation</option>
        {workspace?.conversations.map(chat => <option key={chat.conversationId} value={chat.conversationId}>
          {chat.title} [{chat.phase}] · {chat.conversationId.slice(0, 8)}
        </option>)}
      </select>
      <button className="text-accent underline" onClick={() => useAppStore.getState().togglePanel('squads')}>Manage Squad blueprints</button>
      {workspace?.conversations.filter(chat => chat.conversationId !== selectedId && chat.phase === 'waiting-for-approval').map(chat =>
        <button key={chat.conversationId} className="block text-accent text-left" onClick={() => selectConversation(chat.conversationId)}>
          Action required: {chat.title} · {chat.conversationId.slice(0, 8)}
        </button>)}
      {state?.mount && <p className="break-all text-fg-muted">{state.mount.cwd}<br />
        {state.mount.blueprint.name} v{state.mount.blueprint.revision} · {state.phase}</p>}
    </div>
    <div ref={feed} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3" onScroll={event => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      {welcome && <section aria-label="Plex welcome" className="py-3 text-center">
        <PlexMascot />
        <h2 className="font-semibold text-lg">Meet Plex</h2>
        <p className="text-xs text-fg-muted mt-1">{selectedId
          ? 'Your squad is ready. What would you like to work on?'
          : 'Your workspace. Your squad. One conversation.'}</p>
      </section>}
      {!selectedId && <section className="space-y-3 text-sm">
        <p>Start a conversation by mounting a workspace and choosing a Squad blueprint. Each chat has private Plex and worker histories.</p>
        <select aria-label="Mount Squad blueprint" className="w-full p-2 bg-elevated rounded" value={blueprintId}
          onChange={event => setBlueprintId(event.target.value)}>
          <option value="">Choose a Squad blueprint</option>
          {workspace?.blueprints.map(blueprint => <option key={blueprint.id} value={blueprint.id}>{blueprint.name}</option>)}
        </select>
        <button disabled={mounting || !blueprintId} className="text-accent disabled:opacity-40" onClick={async () => {
          setMounting(true);
          setError(null);
          try {
            const cwd = await window.agentPlex.pickDirectory();
            if (!cwd) return;
            const id = crypto.randomUUID();
            setWorkspace(await window.agentPlex.plexCreateConversation(cwd, blueprintId, id));
            selectConversation(id);
          } catch (error) { setError(String(error)); }
          finally { setMounting(false); }
        }}>{mounting ? 'Mounting...' : 'Choose folder and create chat'}</button>
        {workspace?.migrationNotes.map((note, index) => <p key={index} className="text-xs text-fg-muted">{note}</p>)}
      </section>}
      {state?.messages.map((message, index) => <div key={index}
        aria-label={message.kind === 'plan' ? 'Proposed plan' : undefined}
        className={`${message.kind === 'plan' ? 'bg-purple-400/15 border border-purple-400/40' : 'bg-elevated'} rounded p-2 text-sm whitespace-pre-wrap break-words`}>
        <div className="text-[10px] uppercase text-fg-muted">{message.kind === 'plan' ? 'Plex proposed plan' : message.role === 'plex' ? 'Plex' : message.role}</div>{message.text}
      </div>)}
      {state && <p className="text-xs font-semibold" role="status">
        {approval ? 'A plan is awaiting your decision below.' : state.phase === 'running' || state.phase === 'waiting-for-approval'
          ? 'Workers are running. You can keep talking to Plex; follow-ups may steer an active worker.' : state.phase === 'planning' ? 'Plex is preparing a response...'
            : state.phase === 'summarizing' ? 'Plex is reconciling worker results...' : 'No plan is awaiting approval.'}
      </p>}
      {state && !approval && ['idle', 'interrupted', 'error'].includes(state.phase) &&
        state.tasks.some(task => task.status === 'blocked') && <p className="text-xs text-fg-muted">
          The assignments below belong to a stopped or blocked request, not a pending proposal.
          Earlier messages may describe that plan. Send a new message to request a revised plan.
        </p>}
      {!!state?.activity?.length && <section aria-label="Plex live activity" className="text-xs space-y-2">
        <strong>Live Plex activity</strong>
        {state.activity.map(entry => <div key={entry.id}>
          <span className="text-fg-muted">{entry.kind}</span><pre className="whitespace-pre-wrap break-words">{entry.text}</pre>
        </div>)}
      </section>}
      {approval && state?.plan && selectedId && <section aria-label="Plan approval" className="bg-purple-400/15 border border-purple-400/40 rounded p-3 space-y-2 text-xs">
        <strong>Approve these assignments and tool permissions</strong>
        <p>Workspace: {state.mount?.cwd}</p>
        <p>Plex may answer routine worker questions and dispatch follow-on assignments within this goal using the mounted Squad.
          New scope, additional permissions and decisions requiring your input still come back to you.</p>
        {state.agents.map(agent => <p key={agent.id}>
          {agent.name} ({agent.model ?? 'CLI default'}): {(agent.tools ?? []).join(', ') || 'no tools'}
          {agent.tools?.includes('powershell') && ' — shell has full local user privileges, including writes and network access'}
          {(agent.tools?.includes('create') || agent.tools?.includes('edit')) && ' — may create or edit files'}
        </p>)}
        <button className="text-accent mr-3 disabled:opacity-40" disabled={busy || pending.has(selectedId)} onClick={() =>
          run(selectedId, () => window.agentPlex.plexApprove(selectedId, state.approvalId!))}>Approve plan</button>
        <button className="text-error disabled:opacity-40" disabled={busy || pending.has(selectedId)} onClick={() =>
          run(selectedId, () => window.agentPlex.plexCancel(selectedId, state.approvalId!))}>Reject plan</button>
      </section>}
      {state?.questions?.filter(question => question.status === 'human').map(question => <section key={question.id}
        aria-label="Worker question" className="border border-accent rounded p-3 text-sm space-y-2">
        <strong>Input needed: {state.agents.find(agent => agent.id === question.workerId)?.name}</strong>
        <p className="whitespace-pre-wrap break-words">{question.question}</p>
        <p className="text-xs text-fg-muted">{question.reason}</p>
        {question.choices?.map(choice => <button key={choice} className="block text-accent disabled:opacity-40"
          disabled={deciding.has(question.id)} onClick={async () => {
            if (!selectedId) return;
            setDeciding(previous => new Set(previous).add(question.id));
            try { await run(selectedId, () => window.agentPlex.plexAnswerQuestion(selectedId, question.id, choice)); }
            finally { setDeciding(previous => { const next = new Set(previous); next.delete(question.id); return next; }); }
          }}>{choice}</button>)}
        {question.allowFreeform !== false && <>
          <textarea aria-label="Answer worker question" maxLength={8000} className="w-full bg-elevated rounded p-2"
            value={answers[question.id] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} />
          <button className="text-accent disabled:opacity-40" disabled={deciding.has(question.id) || !answers[question.id]?.trim()}
            onClick={async () => {
              if (!selectedId) return;
              setDeciding(previous => new Set(previous).add(question.id));
              try { await run(selectedId, () => window.agentPlex.plexAnswerQuestion(selectedId, question.id, answers[question.id].trim())); }
              finally { setDeciding(previous => { const next = new Set(previous); next.delete(question.id); return next; }); }
            }}>Send answer</button>
        </>}
      </section>)}
      {!!state?.tasks.length && <h3 className="text-xs font-semibold">
        {approval ? 'Proposed assignments' : ['running', 'waiting-for-approval', 'summarizing'].includes(state.phase)
          ? 'Current assignments' : 'Previous request assignments'}
      </h3>}
      {state?.tasks.map(task => <section key={task.id} className="border border-border rounded p-2 text-xs space-y-1">
        <strong>{task.title} [{task.status}]</strong>
        <p>{state.agents.find(agent => agent.id === (task.assignedAgentId ?? task.agentId))?.name}</p>
        <details open={approval}><summary>Assignment details</summary>
        <p className="whitespace-pre-wrap">{task.instructions}</p><p>Acceptance: {task.acceptance}</p>
        {task.dependsOn.length > 0 && <p>Depends on: {task.dependsOn.join(', ')}</p>}
        {task.jobId && <p className="break-all text-fg-muted">Assignment: {task.jobId}</p>}
        </details>
        {task.error && <p role="alert" className="text-error">{task.error}</p>}
        {task.permissions?.filter(permission => permission.status !== 'resolved' || permission.decision).map(permission => <section key={permission.requestId} aria-label="Worker approval request"
          className="border border-accent rounded p-2 space-y-1">
          <strong>{permission.status === 'pending' ? 'Action required: worker is waiting for approval' :
            permission.status === 'resolved' ? 'Worker permission request resolved by provider' : 'Worker permission request interrupted'}</strong>
          <p>Agent: {state.agents.find(agent => agent.id === task.assignedAgentId)?.name}</p>
          <p className="break-all">Request: {permission.requestId}</p>
          {permission.kind && <p>Kind: {permission.kind}</p>}
          {permission.toolName && <p>Tool: {permission.toolName}</p>}
          {permission.description && <p className="whitespace-pre-wrap break-words">{permission.description}</p>}
          {permission.resource && <p className="break-all">Resource: {permission.resource}</p>}
          {permission.command && <pre className="whitespace-pre-wrap break-words">{permission.command}</pre>}
          {!permission.description && !permission.resource && !permission.command && <p>The CLI supplied no action details.</p>}
          {permission.decision && <p role={permission.decision.status === 'failed' ? 'alert' : 'status'}>
            {permission.decision.value === 'approve-once' ? 'Approve once' : 'Deny'}: {permission.decision.status}.
            {permission.decision.error ? ` ${permission.decision.error} No automatic retry.` :
              permission.decision.status === 'accepted' ? ' The provider applied your decision; this does not mean the assignment completed.' : ''}
          </p>}
          {permission.status === 'pending' && <><p>Approve only this permission request, or deny it and let the worker handle the refusal.
            This does not add tools or grant future permissions. Permission waits time out after ten minutes.</p>
            {!permission.decision && selectedId && task.jobId && <div className="flex gap-3">
              {(['approve-once', 'reject'] as const).map(decision => <button key={decision}
                className="text-accent disabled:opacity-40"
                disabled={deciding.has(`${selectedId}:${task.jobId}:${permission.requestId}`)}
                onClick={async () => {
                  const key = `${selectedId}:${task.jobId}:${permission.requestId}`;
                  setDeciding(previous => new Set(previous).add(key));
                  try {
                    await run(selectedId, () => window.agentPlex.plexPermissionDecision(
                      selectedId, task.jobId!, permission.requestId, decision));
                  } finally { setDeciding(previous => { const next = new Set(previous); next.delete(key); return next; }); }
                }}>{decision === 'approve-once' ? 'Approve once' : 'Deny'}</button>)}
            </div>}
            <button className="text-error" onClick={() => {
              if (selectedId) void run(selectedId, () => window.agentPlex.plexCancel(selectedId));
            }}>Cancel this conversation request</button></>}
          {permission.status === 'resolved' && !permission.decision && <p>The provider reported completion; this event does not establish whether permission was approved or denied.</p>}
          {permission.status === 'interrupted' && <p>This permission request was interrupted and will not be replayed. Any recorded decision is shown above.</p>}
        </section>)}
        {task.result && <details><summary>Queue result: {task.status} (not independently verified)</summary>
          <p className="whitespace-pre-wrap">{task.result.summary}</p>
          {[...task.result.evidence, ...task.result.limitations].map((line, index) => <p key={index}>{line}</p>)}
        </details>}
      </section>)}
      {(error || state?.error) && <p role="alert" className="text-error text-sm whitespace-pre-wrap">{error || state?.error}</p>}
      {state?.phase === 'error' && <p className="text-xs">No new approval is pending. Resolve the error, then send a revised request.</p>}
      {selectedId && requests[selectedId] && !busy && error && <button className="text-accent text-xs"
        onClick={() => send(selectedId, requests[selectedId].text, requests[selectedId].id)}>Retry delivery (same message ID)</button>}
    </div>
    {(busy || working) && selectedId && <button className="text-error text-xs p-2" onClick={() =>
      run(selectedId, () => window.agentPlex.plexCancel(selectedId))}>Cancel current request</button>}
    <form className="p-3 border-t border-border flex gap-2" onSubmit={event => {
      event.preventDefault();
      if (!selectedId || busy || approval || !drafts[selectedId]?.trim()) return;
      void send(selectedId, drafts[selectedId].trim(), crypto.randomUUID());
    }}>
      <textarea aria-label="Message Plex" rows={3} maxLength={8000} placeholder="Ask Plex..."
        className="flex-1 min-w-0 bg-elevated rounded p-2 text-sm" disabled={!selectedId || busy || approval}
        value={selectedId ? drafts[selectedId] ?? '' : ''} onChange={event => {
          if (selectedId) setDrafts(previous => ({ ...previous, [selectedId]: event.target.value }));
        }} />
      <button className="text-accent disabled:opacity-40" disabled={!selectedId || busy || approval || !drafts[selectedId]?.trim()}>Send</button>
    </form>
  </aside>;
}
