const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const { buildExplorerProjects, attentionSessions } = loadSource('src/renderer/session-explorer.ts');
const all = { query: '', status: 'all', cli: 'all' };
const sessions = [
  { id: 'a', title: 'Alpha', cwd: 'C:\\work\\repo', cli: 'copilot', status: 'idle', lastActivityAt: 1 },
  { id: 'b', title: 'Beta', cwd: 'C:\\work\\repo', cli: 'claude', status: 'waiting-for-input', lastActivityAt: 2 },
  { id: 'c', title: 'Gamma', cwd: 'C:\\other\\repo', cli: 'powershell', status: 'running', lastActivityAt: 3 },
];
const flatten = dirs => dirs.flatMap(dir => dir.sessions.map(session => session.id));

test('status and output bursts never reorder explorer projects or sessions', () => {
  const expected = flatten(buildExplorerProjects(sessions, {}, new Map(), all));
  for (let i = 0; i < 200; i++) {
    const changed = sessions.map((session, j) => ({
      ...session, lastActivityAt: i * 100 + j,
      status: ['running', 'waiting-for-input', 'idle', 'killed'][(i + j) % 4],
    })).reverse();
    assert.deepEqual(flatten(buildExplorerProjects(changed, {}, new Map(), all)), expected);
  }
});

test('filters combine name, path, group, status and CLI without mutating inputs', () => {
  const groups = new Map([['b', { label: 'Research' }]]);
  const result = buildExplorerProjects(sessions, { b: 'Planning' }, groups, {
    query: '  PLANNING research C:\\work ', status: 'waiting-for-input', cli: 'claude',
  });
  assert.deepEqual(flatten(result), ['b']);
  assert.equal(result[0].total, 2);
  assert.equal(result[0].sessions[0].label, 'Planning');
  assert.equal(sessions[1].title, 'Beta');
  assert.deepEqual(buildExplorerProjects(sessions, {}, groups, { ...all, query: 'not present' }), []);
  assert.deepEqual(flatten(buildExplorerProjects(sessions, {}, groups, { ...all, cli: 'powershell' })), ['c']);
  assert.equal(flatten(buildExplorerProjects(sessions, {}, groups, all)).length, 3);
});

test('attention contains each waiting session once, ignoring explorer filters; resolves on state change/removal', () => {
  assert.deepEqual(attentionSessions(sessions, { b: 'Renamed' }).map(s => s.label), ['Renamed']);
  assert.deepEqual(attentionSessions(sessions.map(s => ({ ...s, status: 'idle' })), {}), []);
  assert.deepEqual(attentionSessions(sessions.filter(s => s.id !== 'b'), {}), []);
  assert.deepEqual(attentionSessions([], {}), []);
});

test('attention box renders clear state and review controls without approving anything', () => {
  const state = {
    sessions: Object.fromEntries(sessions.map(s => [s.id, s])),
    displayNames: { b: '<Review me>' }, activePaneId: 'b',
    selectSession: () => { throw new Error('Rendering must not act on a session'); },
  };
  const { AttentionBox } = loadSource('src/renderer/components/AttentionBox.tsx', {
    '../store': { useAppStore: selector => selector(state) },
  });
  let html = renderToStaticMarkup(React.createElement(AttentionBox));
  assert.match(html, /Review &lt;Review me&gt;/);
  assert.match(html, /1 sessions waiting for input/);
  assert.match(html, /aria-current="true"/);
  state.sessions = {};
  html = renderToStaticMarkup(React.createElement(AttentionBox));
  assert.match(html, /No sessions waiting for input/);
});

test('explorer retains filters and expand/collapse without adding session-creation controls', () => {
  const state = { sessions: {}, displayNames: {}, nodes: [], openPanes: [] };
  const store = { useAppStore: selector => selector(state) };
  const overrides = { '../../store': store, '../store': store };
  for (const name of ['claude-logo', 'codex-dark', 'codex-light', 'githubcopilot-dark', 'githubcopilot-light']) {
    overrides[`../../../../assets/${name}.svg`] = '';
  }
  const { ExplorerPanel } = loadSource('src/renderer/components/panels/ExplorerPanel.tsx', overrides);
  const html = renderToStaticMarkup(React.createElement(ExplorerPanel));
  for (const label of ['Needs attention', 'Filter sessions', 'Filter by status', 'Filter by CLI',
    'Expand all projects', 'Collapse all projects']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /New session|Create session|<form/);
});
