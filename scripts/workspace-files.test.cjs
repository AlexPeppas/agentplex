const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadSource } = require('./test-support.cjs');
const { createPdf } = require('./pdf-fixture.cjs');
const { createDocx, createXlsx, createDoc } = require('./office-fixtures.cjs');
const { parseOfficePreview } = loadSource('src/main/office-preview-parser.ts');
const { listWorkspaceDirectory, readWorkspaceFile } = loadSource('src/main/workspace-files.ts', {
  './office-preview': { readOfficePreview: parseOfficePreview },
});
const { findArtifactReferences, resolveArtifactLink } = loadSource('src/shared/artifact-links.ts');
const { terminalArtifactReferences } = loadSource('src/shared/artifact-links.ts');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-files-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'workspace'), outside = path.join(home, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'report data.json'), '{"message":"\u03bb"}');
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}');
  return { home, root, outside };
}

test('workspace tree is lazy, sorted, bounded and never follows escaping junctions', async t => {
  const { root, outside } = fixture(t);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  const result = await listWorkspaceDirectory(root);
  assert.equal(result.entries[0].name, 'nested');
  assert.equal(result.entries.find(entry => entry.name === 'escape').blocked, true);
  await assert.rejects(listWorkspaceDirectory(root, 'escape'), /outside/);
  await assert.rejects(readWorkspaceFile(root, path.join('escape', 'secret.json')), /outside/);
  await assert.rejects(listWorkspaceDirectory(root, '..'), /outside/);
  await assert.rejects(readWorkspaceFile(root, path.join(outside, 'secret.json')), /outside/);
  for (let index = 0; index < 501; index++) fs.writeFileSync(path.join(root, `entry-${index}.md`), '');
  const bounded = await listWorkspaceDirectory(root);
  assert.equal(bounded.entries.length, 500);
  assert.equal(bounded.truncated, true);
});

test('previews resolve file URLs, spaces and source locations; session artifacts are explicitly scoped', async t => {
  const { root, outside } = fixture(t);
  for (const reference of ['report data.json:12:3', pathToFileURL(path.join(root, 'report data.json')).href + '#L12']) {
    const result = await readWorkspaceFile(root, reference);
    assert.equal(result.kind, 'json');
    assert.equal(result.content, '{"message":"\u03bb"}');
  }
  const artifact = await readWorkspaceFile(root, path.join(outside, 'secret.json'), outside);
  assert.equal(artifact.name, 'secret.json');
  assert.equal((await readWorkspaceFile(root, 'files/secret.json', outside)).name, 'secret.json');
  await assert.rejects(readWorkspaceFile(root, 'https://example.org/report.json'), /local file/);
  await assert.rejects(readWorkspaceFile(root, 'javascript:alert(1)'), /local file/);
  await assert.rejects(readWorkspaceFile(root, 'missing.md'), /ENOENT/);
});

test('previews reject unsupported, binary, invalid UTF-8, directory and oversized content explicitly', async t => {
  const { root } = fixture(t);
  for (const [name, data, expected] of [
    ['unsupported.exe', 'text', /Unsupported preview/],
    ['binary.md', Buffer.from([0, 1, 2]), /Binary/],
    ['invalid.md', Buffer.from([255]), /UTF-8/],
    ['huge.json', 'x'.repeat(1024 * 1024 + 1), /1 MiB/],
  ]) {
    fs.writeFileSync(path.join(root, name), data);
    await assert.rejects(readWorkspaceFile(root, name), expected);
  }
  fs.mkdirSync(path.join(root, 'directory.md'));
  await assert.rejects(readWorkspaceFile(root, 'directory.md'), /regular file/);
});

test('CSV/TSV preserve quoting, multiline values and literals; large tables are explicitly limited', async t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'data.csv'), '\ufeffName,Notes,Formula\r\n"Last, First","line 1\nline 2",=1+1\r\nshort\r\n');
  const csv = await readWorkspaceFile(root, 'data.csv');
  assert.equal(csv.kind, 'table');
  assert.deepEqual(csv.sheet.rows, [['Name', 'Notes', 'Formula'], ['Last, First', 'line 1\nline 2', '=1+1'], ['short']]);
  fs.writeFileSync(path.join(root, 'data.tsv'), 'A\tB\n1\t2');
  assert.deepEqual((await readWorkspaceFile(root, 'data.tsv')).sheet.rows, [['A', 'B'], ['1', '2']]);
  fs.writeFileSync(path.join(root, 'large.csv'), ('x,'.repeat(110) + 'x\n').repeat(1002));
  const large = (await readWorkspaceFile(root, 'large.csv')).sheet;
  assert.equal(large.truncated, true);
  assert.equal(large.rows.length, 200);
  assert.equal(large.rows[0].length, 100);
  fs.writeFileSync(path.join(root, 'bad.csv'), 'a,"unfinished');
  await assert.rejects(readWorkspaceFile(root, 'bad.csv'), /Quote|quote/);
});

test('common text/code and Mermaid files are readable without interpreting their content', async t => {
  const { root } = fixture(t);
  for (const name of ['notes.txt', 'debug.log', 'config.yaml', 'source.ts', 'data.xml', 'events.jsonl', 'diagram.mmd', 'diagram.mermaid']) {
    fs.writeFileSync(path.join(root, name), '<script>doNotExecute()</script>\nflowchart LR\nA-->B');
    const file = await readWorkspaceFile(root, name);
    assert.equal(file.kind, name.includes('diagram') ? 'mermaid' : 'text');
    assert.match(file.content, /doNotExecute/);
    assert.equal(findArtifactReferences('Open `' + name + '`')[0]?.reference, name);
  }
  fs.writeFileSync(path.join(root, 'unicode.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('UTF16 λ', 'utf16le')]));
  assert.equal((await readWorkspaceFile(root, 'unicode.txt')).content, 'UTF16 λ');
});

test('Word DOCX structure is sanitized, legacy DOC text is extracted and XLSX sheets keep cached values', async t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'report.docx'), await createDocx());
  const docx = await readWorkspaceFile(root, 'report.docx');
  assert.equal(docx.kind, 'document');
  assert.equal(docx.format, 'html');
  assert.match(docx.content, /<h1>Native Word preview<\/h1>/);
  assert.match(docx.content, /<strong>Generated report &amp; evidence<\/strong>/);
  assert.match(docx.content, /<table>/);
  assert.doesNotMatch(docx.content, /href|javascript:|<script|<img/i);
  fs.writeFileSync(path.join(root, 'legacy.doc'), createDoc());
  const doc = await readWorkspaceFile(root, 'legacy.doc');
  assert.equal(doc.kind, 'document');
  assert.equal(doc.format, 'text');
  assert.match(doc.content, /Legacy Word preview\nSynthetic evidence/);
  fs.writeFileSync(path.join(root, 'book.xlsx'), await createXlsx());
  const book = await readWorkspaceFile(root, 'book.xlsx');
  assert.equal(book.kind, 'workbook');
  assert.deepEqual(book.sheets.map(sheet => sheet.name), ['Summary', 'Details']);
  assert.deepEqual(book.sheets[0].rows[2], ['Computed', '84']);
  assert.deepEqual(book.sheets[0].rows[3], ['Uncached', '[Formula: no cached result]']);
  assert.equal(book.sheets[0].rows[4][1].startsWith('=HYPERLINK'), true);
  assert.equal(book.sheets[0].rows[5][1], 'Hello World');
  assert.equal(book.sheets[0].rows[6][1], 'Visible link text');
});

test('Office parser rejects malformed and expanded oversized archives, with explicit workbook truncation', async () => {
  const JSZip = require('jszip');
  await assert.rejects(parseOfficePreview(Buffer.from('not word'), '.doc'), /legacy Word/);
  for (const [offset, value] of [[30, 30], [44, 0x7fffffff]]) {
    const invalidDoc = createDoc();
    invalidDoc.writeUIntLE(value, offset, offset === 30 ? 2 : 4);
    await assert.rejects(parseOfficePreview(invalidDoc, '.doc'), /compound-document header/);
  }
  await assert.rejects(parseOfficePreview(Buffer.from('not zip'), '.docx'));
  const invalid = new JSZip();
  invalid.file('word/document.xml', 'x'.repeat(40 * 1024 * 1024 + 1));
  await assert.rejects(parseOfficePreview(await invalid.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), '.docx'), /40 MiB/);
  const large = await parseOfficePreview(await createXlsx(true), '.xlsx');
  assert.equal(large.truncated, true);
  assert.equal(large.sheets.length, 20);
  assert.equal(large.sheets[0].truncated, true);
  assert.ok(large.sheets.reduce((count, sheet) => count + sheet.rows.reduce((sum, row) => sum + row.length, 0), 0) <= 20000);
});

test('HTML preserves native layout but removes executable elements, refreshes and navigation attributes', async t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'report.html'), '<style>h1{color:blue}</style><h1>Report</h1>'
    + '<script>evil()</script><iframe src="https://example.invalid"></iframe><meta http-equiv="refresh" content="0;url=https://example.invalid">'
    + '<a href="https://example.invalid" onclick="evil()">Read</a><svg><a xlink:href="https://example.invalid">SVG</a></svg>');
  const file = await readWorkspaceFile(root, 'report.html');
  assert.match(file.content, /<style>h1\{color:blue\}<\/style><h1>Report<\/h1>/);
  assert.doesNotMatch(file.content, /script|iframe|meta|href|onclick|evil\(/i);
});

test('PDF reads preserve binary bytes and enforce signature, scope and the separate 20 MiB limit', async t => {
  const { root, outside } = fixture(t);
  const bytes = Buffer.concat([createPdf(), Buffer.from([0, 255, 128])]);
  fs.writeFileSync(path.join(root, 'report.pdf'), bytes);
  const file = await readWorkspaceFile(root, 'report.pdf');
  assert.equal(file.kind, 'pdf');
  assert.deepEqual(Buffer.from(file.base64, 'base64'), bytes);
  fs.writeFileSync(path.join(root, 'invalid.pdf'), 'not a PDF');
  await assert.rejects(readWorkspaceFile(root, 'invalid.pdf'), /valid PDF/);
  const large = Buffer.alloc(20 * 1024 * 1024, 0);
  large.write('%PDF-1.7\n');
  fs.writeFileSync(path.join(root, 'large.pdf'), large);
  assert.equal(Buffer.from((await readWorkspaceFile(root, 'large.pdf')).base64, 'base64').length, large.length);
  fs.appendFileSync(path.join(root, 'large.pdf'), 'x');
  await assert.rejects(readWorkspaceFile(root, 'large.pdf'), /20 MiB/);
  fs.writeFileSync(path.join(outside, 'private.pdf'), bytes);
  await assert.rejects(readWorkspaceFile(root, path.join(outside, 'private.pdf')), /outside/);
  assert.deepEqual(Buffer.from((await readWorkspaceFile(root, 'files/private.pdf', outside)).base64, 'base64'), bytes);
});

test('terminal references include Markdown, quoted Windows paths, file URLs and source locations without web URLs', () => {
  const text = '[report](reports/report data.md) `config.json:12:3` "C:\\My Files\\index.html" file:///C:/repo/data.json#L7 https://example.org/page.html [PDF](docs/my report.pdf) file:///C:/repo/report.PDF';
  const links = findArtifactReferences(text);
  assert.deepEqual(links.map(link => link.reference), [
    'reports/report data.md', 'config.json:12:3', 'C:\\My Files\\index.html', 'file:///C:/repo/data.json#L7',
    'docs/my report.pdf', 'file:///C:/repo/report.PDF',
  ]);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.reference);
  assert.equal(resolveArtifactLink('C:\\repo\\reports\\summary.md', '../data.json'), 'file:///C:/repo/data.json');
});

test('real xterm links span wrapped rows and retain correct cells after Unicode text', async t => {
  const { Terminal } = require('@xterm/xterm');
  const term = new Terminal({ cols: 24, rows: 8 });
  t.after(() => term.dispose());
  const reference = 'C:\\workspace folder\\generated\\report.json';
  await new Promise(resolve => term.write('\u4e2d\ud83d\ude80 `' + reference + '`', resolve));
  const links = terminalArtifactReferences(term.buffer.active, term.cols, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].reference, reference);
  assert.deepEqual(links[0].range.start, { x: 6, y: 1 });
  assert.ok(links[0].range.end.y > 1);
  const continuation = terminalArtifactReferences(term.buffer.active, term.cols, 2);
  assert.deepEqual(continuation, links);
});
