const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

function templatePanel(state, templates = []) {
  let index = 0;
  const values = [templates, 'Workspace', false, null, null, ''];
  const useAppStore = selector => selector(state);
  useAppStore.getState = () => state;
  const jsx = (type, props) => ({ type, props });
  const { TemplatesPanel } = loadSource('src/renderer/components/panels/TemplatesPanel.tsx', {
    react: {
      useState: () => [values[index++], () => {}], useRef: current => ({ current }),
      useEffect() {}, useCallback: fn => fn,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': {}, '../../store': { useAppStore },
  });
  const tree = TemplatesPanel();
  function find(node, title) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && node.props.title === title) return node;
    for (const child of [node.props?.children].flat(2)) {
      const match = find(child, title);
      if (match) return match;
    }
  }
  return title => find(tree, title).props.onClick();
}

function session(id, resumeSessionId, cli = 'copilot') {
  return { id, resumeSessionId, cli, cwd: process.cwd(), title: 'Same name', status: 'idle', startedAt: 123 };
}

test('template save uses each conversation UUID even when display names collide', async () => {
  const previous = global.window;
  let saved;
  global.window = { agentPlex: { templatesSave: async value => { saved = value; } } };
  try {
    const click = templatePanel({
      sessions: { a: session('a', 'uuid-a'), b: session('b', 'uuid-b') },
      displayNames: { a: 'Same name', b: 'Same name' }, addSession() {},
    });
    await click('Save current sessions as template');
    assert.deepEqual(saved[0].sessions.map(s => s.sessionId), ['uuid-a', 'uuid-b']);
  } finally { global.window = previous; }
});

test('template launch deduplicates provider UUIDs, not names, including pending duplicate clicks and repeated members', async () => {
  const previous = global.window;
  const launched = [];
  let release;
  const state = {
    sessions: { existing: session('existing', 'uuid-a') }, displayNames: {}, renameSession() {},
    addSession(info) { state.sessions[info.id] = info; },
  };
  global.window = { agentPlex: {
    createSession: async (cwd, cli, uuid) => {
      launched.push([cli, uuid]);
      if (launched.length === 1) await new Promise(resolve => { release = resolve; });
      return session(`new-${launched.length}`, uuid ?? null, cli);
    },
  } };
  try {
    const entries = [
      { cli: 'copilot', sessionId: 'uuid-a' }, { cli: 'copilot', sessionId: 'uuid-b' },
      { cli: 'copilot', sessionId: 'uuid-b' }, { cli: 'claude', sessionId: 'uuid-a' },
      { cli: 'copilot-resume', sessionId: 'uuid-a' }, { cli: 'claude-resume', sessionId: 'uuid-a' },
      { cli: 'shell' }, { cli: 'shell' },
    ].map(s => ({ name: 'Same name', cwd: process.cwd(), ...s }));
    const click = templatePanel(state, [{ id: 'tpl', name: 'Workspace', createdAt: new Date().toISOString(), sessions: entries }]);
    const first = click('Launch template');
    await click('Launch template');
    assert.deepEqual(launched, [['copilot', 'uuid-b']]);
    release();
    await first;
    assert.deepEqual(launched, [['copilot', 'uuid-b'], ['claude', 'uuid-a'], ['shell', undefined], ['shell', undefined]]);
  } finally { global.window = previous; }
});

function withStore(run) {
  const prior = { window: global.window, document: global.document, getComputedStyle: global.getComputedStyle };
  global.window = { agentPlex: { updateSessionState() {} } };
  global.document = { documentElement: {} };
  global.getComputedStyle = () => ({ getPropertyValue: () => '#abcdef' });
  try {
    const { useAppStore, serializeGroups } = loadSource('src/renderer/store.ts', {
      './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
    });
    const save = () => {
      const s = useAppStore.getState();
      return serializeGroups(s.nodes, s.sessions, s.unresolvedGroups);
    };
    run(useAppStore, save);
  } finally { Object.assign(global, prior); }
}

test('menu grouping does not cover existing cards, including members of other groups', () => {
  withStore(store => {
    for (const id of ['anchor', 'joining', 'near', 'below']) store.getState().addSession(session(id, id));
    store.setState({ nodes: store.getState().nodes.map(node => ({
      ...node, position: { x: 0, y: 0 }, measured: { width: 240, height: 120 },
    })) });
    store.getState().createGroupWithMembers(['anchor']);
    const group = store.getState().nodes.find(node => node.type === 'groupNode');
    const x = group.position.x + group.width + 40;
    const y = group.position.y + group.width / 2 - 60;
    store.setState({ nodes: store.getState().nodes.map(node => node.id === 'near' || node.id === 'below'
      ? { ...node, position: { x, y: y + (node.id === 'below' ? 140 : 0) } } : node) });
    store.getState().createGroupWithMembers(['below']);
    const rectangles = () => store.getState().nodes.filter(node => node.type === 'sessionNode').map(node => {
      const parent = store.getState().nodes.find(other => other.id === node.parentId);
      return { id: node.id, x: node.position.x + (parent?.position.x ?? 0),
        y: node.position.y + (parent?.position.y ?? 0), ...node.measured };
    });
    const before = rectangles().filter(node => node.id !== 'joining');
    store.getState().addToGroup(group.id, 'joining', { reposition: true });
    const after = rectangles();
    const joined = after.find(node => node.id === 'joining');
    for (const other of before) {
      assert.deepEqual(after.find(node => node.id === other.id), other, 'existing cards stay fixed');
      assert.ok(joined.x >= other.x + other.width || joined.x + joined.width <= other.x
        || joined.y >= other.y + other.height || joined.y + joined.height <= other.y,
      `joining card must not cover ${other.id}`);
    }
    assert.equal(store.getState().nodes.find(node => node.id === 'joining').parentId, group.id);
  });
});

test('grouping preserves deliberate drag positions and manually sized circle placement', () => {
  for (const manual of [false, true]) withStore(store => {
    store.getState().addSession(session('anchor', 'anchor'));
    store.getState().addSession(session('joining', 'joining'));
    store.getState().createGroupWithMembers(['anchor']);
    const groupId = store.getState().nodes.find(node => node.type === 'groupNode').id;
    if (manual) store.getState().resizeGroup(groupId, 400);
    const group = store.getState().nodes.find(node => node.id === groupId);
    const joining = store.getState().nodes.find(node => node.id === 'joining');
    const expected = manual
      ? { x: group.position.x + 200 - 90, y: group.position.y + 200 - 28 }
      : joining.position;
    store.getState().addToGroup(groupId, joining.id, { reposition: manual });
    const updatedGroup = store.getState().nodes.find(node => node.id === groupId);
    const updated = store.getState().nodes.find(node => node.id === joining.id);
    assert.deepEqual({ x: updatedGroup.position.x + updated.position.x,
      y: updatedGroup.position.y + updated.position.y }, expected);
    if (manual) assert.equal(updatedGroup.width, 400);
  });
});

test('missing or ambiguous group UUIDs never fall back to reused transient IDs and survive saves', () => {
  for (const live of [[session('session-1', 'other')], [session('session-1', 'saved'), session('session-2', 'saved')]]) {
    withStore((store, save) => {
      live.forEach(info => store.getState().addSession(info));
      const original = { groups: [{ label: 'Saved', color: '#abcdef', members: [{ sessionId: 'session-1', resumeSessionId: 'saved' }] }] };
      store.getState().restoreGroups(original);
      assert.ok(store.getState().nodes.every(n => !n.parentId));
      assert.deepEqual(save(), original);
    });
  }
});

test('unique group UUIDs remap by provider, while unresolved members survive the last live member disappearing', () => {
  withStore((store, save) => {
    store.getState().addSession(session('new', 'saved'));
    store.getState().addSession(session('other-provider', 'saved', 'claude'));
    store.getState().restoreGroups({ groups: [{ label: 'Saved', color: '#abcdef', members: [
      { sessionId: 'old', resumeSessionId: 'saved', cli: 'copilot-resume', position: { x: 45, y: 67 } },
      { sessionId: 'missing', resumeSessionId: 'later', cli: 'copilot' },
    ] }] });
    const node = store.getState().nodes.find(n => n.id === 'new');
    assert.ok(node.parentId);
    assert.equal(store.getState().nodes.find(n => n.id === 'other-provider').parentId, undefined);
    const restored = save().groups[0];
    assert.equal(restored.members.find(m => m.sessionId === 'new').position.x, 45);
    assert.equal(restored.members.length, 2);
    store.getState().renameGroup(node.parentId, 'Renamed');
    store.getState().removeFromGroup('new');
    assert.equal(save().groups[0].label, 'Renamed');
    assert.deepEqual(save().groups[0].members, [{ sessionId: 'missing', resumeSessionId: 'later', cli: 'copilot' }]);
  });
});

test('non-resumable groups require the original PTY creation time, preserving renderer-only reloads', () => {
  for (const startedAt of [123, 999, undefined]) {
    withStore((store, save) => {
      store.getState().addSession(session('session-1', null, 'shell'));
      store.getState().restoreGroups({ groups: [{ label: 'Shell', color: '#abcdef', members: [
        { sessionId: 'session-1', resumeSessionId: null, cli: 'shell', startedAt },
      ] }] });
      assert.equal(!!store.getState().nodes.find(n => n.id === 'session-1').parentId, startedAt === 123);
      assert.equal(save().groups[0].members.length, 1);
    });
  }
});
