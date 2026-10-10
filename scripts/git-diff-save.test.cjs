const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { saveFile } = loadSource('src/main/git-operations.ts');

function elements(value) {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value?.props) return [];
  return [value, ...elements(value.props.children)];
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-git-save-'));
  const previousWindow = global.window;
  const initial = { 'a.txt': 'A_INITIAL\n', 'b.txt': 'B_INITIAL\n' };
  for (const [name, content] of Object.entries(initial)) fs.writeFileSync(path.join(root, name), content);
  const hooks = [], commands = [], writes = [];
  let index, effects, tree, mountedKey, mountedEditor, editorValue, modified;
  let pendingDiff, pendingSave;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const DiffEditor = 'SyntheticDiffEditor';
  global.window = { agentPlex: {
    gitStatus: async () => ({ isRepo: true, files: Object.keys(initial).map(name => ({ path: name, staged: false, status: 'M' })) }),
    gitBranchInfo: async () => null,
    gitFileDiff: (_session, name) => pendingDiff?.name === name
      ? new Promise(resolve => { pendingDiff.resolve = resolve; })
      : Promise.resolve({ original: '', modified: initial[name], language: 'plaintext' }),
    gitSaveFile: async (sessionId, name, content) => {
      writes.push({ sessionId, name, content });
      if (pendingSave) await new Promise(resolve => { pendingSave.resolve = resolve; });
      await saveFile(root, name, content);
    },
    onZoom: () => () => {},
  } };
  const { GitDiffPanel } = loadSource('src/renderer/components/GitDiffPanel.tsx', {
    '@monaco-editor/react': { DiffEditor, loader: { config() {} } },
    react: {
      useState(initialValue) {
        const slot = index++;
        hooks[slot] ??= { value: initialValue };
        return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; }];
      },
      useRef(initialValue) { const slot = index++; return hooks[slot] ??= { current: initialValue }; },
      useCallback(callback, deps) {
        const slot = index++;
        if (!equal(hooks[slot]?.deps, deps)) hooks[slot] = { callback, deps };
        return hooks[slot].callback;
      },
      useEffect(callback, deps) {
        const slot = index++;
        if (!equal(hooks[slot]?.deps, deps)) {
          const cleanup = hooks[slot]?.cleanup;
          hooks[slot] = { deps };
          effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
        }
      },
    },
  });
  function render() {
    index = 0; effects = [];
    tree = GitDiffPanel({ sessionId: 'test-session' });
    const view = elements(tree).find(el => el.props.onMount && Object.hasOwn(el.props, 'modified'));
    const diff = view?.type === DiffEditor ? view : view?.type(view.props);
    for (const effect of effects) effect();
    if (!diff) { mountedKey = undefined; return; }
    if (mountedKey !== view.key) {
      mountedKey = view.key;
      editorValue = diff.props.modified;
      modified = () => {};
      mountedEditor = {
        getModel: () => null, setModel() {},
        getOriginalEditor: () => ({ updateOptions() {} }),
        getModifiedEditor: () => ({
          getValue: () => editorValue, updateOptions() {},
          onDidChangeModelContent: callback => { modified = callback; },
          addCommand: (_key, callback) => commands.push(callback),
        }),
      };
      diff.props.onMount(mountedEditor);
    }
  }
  async function redraw() { for (let i = 0; i < 5; i++) { render(); await Promise.resolve(); } }
  t.after(() => {
    for (const hook of hooks) hook?.cleanup?.();
    if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
    for (const name of Object.keys(initial)) fs.unlinkSync(path.join(root, name));
    fs.rmdirSync(root);
  });
  return {
    redraw, commands, writes,
    select(name) { render(); elements(tree).find(el => el.key === `u-${name}`).props.onClick(); },
    edit(content) { editorValue = content; modified(); },
    button() { render(); return elements(tree).find(el => el.props.title === 'Save (Ctrl+S)'); },
    read(name) { return fs.readFileSync(path.join(root, name), 'utf8'); },
    holdDiff(name) { pendingDiff = { name }; },
    releaseDiff(name) { const held = pendingDiff; pendingDiff = null; held.resolve({ original: '', modified: initial[name], language: 'plaintext' }); },
    holdSave() { pendingSave = {}; },
    releaseSave() { const held = pendingSave; pendingSave = null; held.resolve(); },
  };
}

test('keyboard saves follow the mounted file, while button saves preserve other files', async t => {
  const f = fixture(t);
  await f.redraw();
  f.select('a.txt'); await f.redraw();
  f.edit('A_EDITED\n'); await f.redraw();
  await f.commands.at(-1)();
  f.select('b.txt'); await f.redraw();
  f.edit('B_EDITED\n'); await f.redraw();
  await f.commands.at(-1)();
  assert.equal(f.read('a.txt'), 'A_EDITED\n');
  assert.equal(f.read('b.txt'), 'B_EDITED\n');
  f.edit('B_BUTTON\n'); await f.redraw();
  await f.button().props.onClick();
  assert.equal(f.read('a.txt'), 'A_EDITED\n');
  assert.equal(f.read('b.txt'), 'B_BUTTON\n');
});

test('a pending selected diff cannot save the previously mounted file contents', async t => {
  const f = fixture(t);
  await f.redraw();
  f.select('a.txt'); await f.redraw();
  f.edit('A_UNSAVED\n'); await f.redraw();
  f.holdDiff('b.txt');
  f.select('b.txt'); await f.redraw();
  assert.equal(f.button().props.disabled, true);
  await f.button().props.onClick();
  assert.equal(f.writes.length, 0);
  assert.equal(f.read('b.txt'), 'B_INITIAL\n');
  f.releaseDiff('b.txt'); await f.redraw();
  f.edit('B_EDITED\n'); await f.redraw();
  await f.commands.at(-1)();
  assert.equal(f.read('a.txt'), 'A_INITIAL\n');
  assert.equal(f.read('b.txt'), 'B_EDITED\n');
});

test('an old save completion cannot clear edits made in the next mounted file', async t => {
  const f = fixture(t);
  await f.redraw();
  f.select('a.txt'); await f.redraw();
  f.edit('A_EDITED\n'); await f.redraw();
  f.holdSave();
  const saving = f.commands.at(-1)();
  await f.redraw();
  f.select('b.txt'); await f.redraw();
  f.edit('B_EDITED\n'); await f.redraw();
  f.releaseSave(); await saving; await f.redraw();
  assert.equal(f.button().props.disabled, false);
  await f.button().props.onClick();
  assert.equal(f.read('a.txt'), 'A_EDITED\n');
  assert.equal(f.read('b.txt'), 'B_EDITED\n');
});
