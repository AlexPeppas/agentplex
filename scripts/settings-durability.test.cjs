const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSource } = require('./test-support.cjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-settings-'));
  const file = path.join(home, '.agentplex', 'settings.json');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let failure;
  const overrides = { fs: { ...fs,
    readFileSync: (...args) => {
      if (failure === 'read') throw Object.assign(new Error('Synthetic access denied'), { code: 'EACCES' });
      return fs.readFileSync(...args);
    },
    writeFileSync: (fd, ...args) => {
      if (failure === 'write') {
        fs.writeSync(fd, '{partial');
        throw new Error('Synthetic partial write');
      }
      return fs.writeFileSync(fd, ...args);
    },
    renameSync: (...args) => {
      if (failure === 'rename') throw new Error('Synthetic replacement failure');
      return fs.renameSync(...args);
    },
  }, os: { ...os, homedir: () => home } };
  const settings = loadSource('src/main/settings-manager.ts', overrides);
  const write = value => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { file, settings, write, fail: value => { failure = value; } };
}

test('changing the default shell preserves externally edited launch config and unknown preferences', t => {
  const f = fixture(t);
  f.write({ defaultShell: 'old', claude: { command: 'old-command' } });
  assert.equal(f.settings.getDefaultShellId(), 'old');
  const edited = { defaultShell: 'externally-set', claude: { command: 'new-command', flags: ['--model', 'new-model'] },
    newPreference: { enabled: true, values: [1, 2, 3] } };
  f.write(edited);
  assert.equal(f.settings.getDefaultShellId(), 'externally-set', 'reads cannot retain stale settings');
  f.settings.setDefaultShellId('new-shell');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { ...edited, defaultShell: 'new-shell' });
  assert.equal(f.settings.getDefaultShellId(), 'new-shell');
});

test('first-run settings are created atomically without requiring an existing directory', t => {
  const f = fixture(t);
  assert.equal(f.settings.getDefaultShellId(), undefined);
  f.settings.setDefaultShellId('pwsh');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { defaultShell: 'pwsh' });
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['settings.json']);
});

test('unreadable, malformed and invalid settings cannot be replaced with an empty snapshot', t => {
  const f = fixture(t);
  t.mock.method(console, 'error', () => {});
  for (const raw of ['{broken', 'null', '[]', '"text"', '{"defaultShell":42}']) {
    f.write(raw);
    assert.throws(() => f.settings.setDefaultShellId('new'));
    assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['settings.json']);
  }
  f.write({ defaultShell: 'old', important: true });
  f.fail('read');
  assert.throws(() => f.settings.setDefaultShellId('new'), /access denied/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { defaultShell: 'old', important: true });
  f.fail(undefined);
  f.settings.setDefaultShellId('recovered');
  assert.equal(f.settings.getDefaultShellId(), 'recovered');
});

test('partial writes and failed replacements leave settings and subsequent reads unchanged', t => {
  const f = fixture(t);
  t.mock.method(console, 'error', () => {});
  const saved = { defaultShell: 'old', claude: { command: 'custom-command' } };
  f.write(saved);
  for (const failure of ['write', 'rename']) {
    f.fail(failure);
    assert.throws(() => f.settings.setDefaultShellId('not-saved'), /Synthetic/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), saved);
    assert.equal(f.settings.getDefaultShellId(), 'old');
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['settings.json']);
  }
  f.fail(undefined);
  f.settings.setDefaultShellId('saved-after-recovery');
  assert.equal(f.settings.getDefaultShellId(), 'saved-after-recovery');
});
