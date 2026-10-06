import { useEffect, useState } from 'react';
import { PLEX_TOOL_CATALOG, PLEX_WORKER_TOOLS, type PlexModel, type PlexSquadBlueprint } from '../../../shared/plex';
import { usePlexStore } from '../../plex-store';

const newAgent = () => ({
  id: crypto.randomUUID(), name: '', description: '', instructions: '', tools: [...PLEX_WORKER_TOOLS],
});

export function SquadsPanel() {
  const { workspace, setWorkspace, error, setError } = usePlexStore();
  const [draft, setDraft] = useState<PlexSquadBlueprint | null>(null);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<PlexModel[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadingModels(true);
    setModelError(null);
    window.agentPlex.plexModels().then(models => { if (active) setModels(models); })
      .catch(error => { if (active) setModelError(String(error)); })
      .finally(() => { if (active) setLoadingModels(false); });
    return () => { active = false; };
  }, [modelRefresh]);
  useEffect(() => {
    window.agentPlex.plexWorkspace().then(setWorkspace).catch(error => setError(String(error)));
  }, [setWorkspace, setError]);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try { setWorkspace(await window.agentPlex.plexSaveBlueprint(draft)); setDraft(null); }
    catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  };
  return <div className="p-3 h-full overflow-y-auto text-xs space-y-3">
    <p>Blueprints define Copilot agents, not running terminals. Choose a workspace when starting a Plex chat.</p>
    <button className="text-accent" onClick={() => setDraft({
      id: crypto.randomUUID(), name: 'New squad', revision: 1, agents: [{ ...newAgent(), name: 'dev-arch', description: 'Architecture and design review' }],
    })}>New Squad blueprint</button>
    {workspace?.blueprints.map(blueprint => <div key={blueprint.id} className="border border-border p-2 rounded">
      <strong>{blueprint.name}</strong> <span className="text-fg-muted">v{blueprint.revision}</span>
      <p>{blueprint.agents.map(agent => agent.name).join(', ')}</p>
      <button className="text-accent mr-3" onClick={() => setDraft(structuredClone(blueprint))}>Edit {blueprint.name}</button>
      <button className="text-error" disabled={saving} onClick={async () => {
        setSaving(true);
        try { setWorkspace(await window.agentPlex.plexDeleteBlueprint(blueprint.id)); }
        catch (error) { setError(String(error)); }
        finally { setSaving(false); }
      }}>Delete blueprint</button>
    </div>)}
    {draft && <section aria-label="Squad blueprint editor" className="space-y-3">
      <label className="block">Squad name
        <input aria-label="Squad name" maxLength={200} className="w-full p-2 bg-elevated rounded" value={draft.name}
          onChange={event => setDraft({ ...draft, name: event.target.value })} />
      </label>
      {draft.agents.map((agent, index) => {
        const update = (patch: Partial<typeof agent>) => setDraft({
          ...draft, agents: draft.agents.map((item, i) => i === index ? { ...item, ...patch } : item),
        });
        return <fieldset key={agent.id} className="border border-border rounded p-2 space-y-2">
          <legend>Agent {index + 1}</legend>
          <input aria-label={`Agent ${index + 1} name`} placeholder="dev-arch" maxLength={200}
            className="w-full p-2 bg-elevated rounded" value={agent.name} onChange={event => update({ name: event.target.value })} />
          <label className="block">Copilot model
            <select aria-label={`Agent ${index + 1} model`} className="w-full p-2 bg-elevated rounded"
              value={agent.model ?? ''} onChange={event => update({ model: event.target.value || undefined })}>
              <option value="">CLI default</option>
              {agent.model && !models.some(model => model.id === agent.model) &&
                <option value={agent.model}>{agent.model} (saved; availability unverified)</option>}
              {models.map(model => <option key={model.id} value={model.id} disabled={!model.enabled}>
                {model.name}{!model.enabled ? ' (not enabled)' : ''}
              </option>)}
            </select>
          </label>
          <textarea aria-label={`Agent ${index + 1} description`} placeholder="Short routing description" maxLength={2000}
            className="w-full p-2 bg-elevated rounded" value={agent.description} onChange={event => update({ description: event.target.value })} />
          <textarea aria-label={`Agent ${index + 1} instructions`} placeholder="Optional agent instructions" maxLength={8000}
            className="w-full p-2 bg-elevated rounded" value={agent.instructions} onChange={event => update({ instructions: event.target.value })} />
          {PLEX_TOOL_CATALOG.map(tool => <label key={tool.id} className="flex gap-2 items-start">
            <input type="checkbox" checked={agent.tools.includes(tool.id)} onChange={event => update({
              tools: event.target.checked ? [...agent.tools, tool.id] : agent.tools.filter(id => id !== tool.id),
            })} />
            <span>{tool.label} <code>({tool.id})</code></span>
          </label>)}
          <button className="text-error" disabled={draft.agents.length === 1}
            onClick={() => setDraft({ ...draft, agents: draft.agents.filter((_, i) => i !== index) })}>Remove agent</button>
        </fieldset>;
      })}
      <p className="text-fg-muted">Tools are explicit permissions, not an OS sandbox. Shell commands can read, change or delete anything your account can access. Existing chats retain their mounted blueprint revision.</p>
      <p className="text-fg-muted">{loadingModels ? 'Loading models from the installed Copilot CLI...' :
        'Model choices are discovered from your authenticated CLI. Existing chats keep their selected model.'}</p>
      {modelError && <p role="alert" className="text-error">{modelError}</p>}
      <button className="text-accent block" disabled={loadingModels} onClick={() => setModelRefresh(value => value + 1)}>Refresh models</button>
      <button className="text-accent mr-3" disabled={draft.agents.length >= 4} onClick={() =>
        setDraft({ ...draft, agents: [...draft.agents, newAgent()] })}>Add agent</button>
      <button className="text-accent mr-3" disabled={saving} onClick={save}>Save blueprint</button>
      <button disabled={saving} onClick={() => setDraft(null)}>Cancel editing</button>
    </section>}
    {workspace?.migrationNotes.map((note, index) => <p key={index} className="text-fg-muted">{note}</p>)}
    {error && <p role="alert" className="text-error">{error}</p>}
  </div>;
}
