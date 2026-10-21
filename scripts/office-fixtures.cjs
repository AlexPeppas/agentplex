const JSZip = require('jszip');
const ExcelJS = require('exceljs');

async function createDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="unsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Native Word preview</w:t></w:r></w:p>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Generated report &amp; evidence</w:t></w:r></w:p>'
    + '<w:p><w:hyperlink r:id="unsafe"><w:r><w:t>Unsafe link text</w:t></w:r></w:hyperlink></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Document cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createXlsx(large = false) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Summary');
  sheet.addRow(['Metric', 'Value']);
  sheet.addRow(['Revenue', 42]);
  sheet.addRow(['Computed', { formula: 'B2*2', result: 84 }]);
  sheet.addRow(['Uncached', { formula: 'B2*3' }]);
  sheet.addRow(['Literal', '=HYPERLINK("https://preview-test.invalid","not executed")']);
  sheet.addRow(['Rich text', { richText: [{ text: 'Hello ' }, { text: 'World' }] }]);
  sheet.addRow(['Website', { text: 'Visible link text', hyperlink: 'https://preview-test.invalid' }]);
  workbook.addWorksheet('Details').addRow(['Second sheet', 'λ']);
  if (large) {
    sheet.getCell('CW1001').value = 'Beyond both limits';
    for (let i = 0; i < 20; i++) workbook.addWorksheet(`Extra ${i}`).addRow(['extra']);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function createDoc(text = 'Legacy Word preview\rSynthetic evidence\r') {
  // Minimal synthetic CFB container with regular WordDocument/0Table streams.
  const header = Buffer.alloc(512, 0);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header);
  header.writeUInt16LE(0x3e, 24); header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28); header.writeUInt16LE(9, 30); header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44); header.writeInt32LE(16, 48); header.writeUInt32LE(4096, 56);
  header.writeInt32LE(-2, 60); header.writeInt32LE(-2, 68);
  for (let offset = 76; offset < 512; offset += 4) header.writeInt32LE(-1, offset);
  header.writeInt32LE(17, 76);
  const word = Buffer.alloc(4096);
  word.writeUInt16LE(0xa5ec, 0); word.writeUInt16LE(0xc1, 2);
  word.writeUInt32LE(512, 0x18); word.writeUInt32LE(text.length, 0x4c);
  word.writeUInt32LE(21, 0x1a6);
  word.write(text, 512, 'utf16le');
  const table = Buffer.alloc(4096);
  table[0] = 2; table.writeUInt32LE(16, 1); table.writeUInt32LE(text.length, 9); table.writeUInt32LE(512, 15);
  const directory = Buffer.alloc(512);
  const entry = (index, name, type, start, size, child = -1, right = -1) => {
    const offset = index * 128;
    directory.write(name + '\0', offset, 'utf16le');
    directory.writeUInt16LE((name.length + 1) * 2, offset + 64);
    directory[offset + 66] = type; directory[offset + 67] = 1;
    directory.writeInt32LE(-1, offset + 68); directory.writeInt32LE(right, offset + 72);
    directory.writeInt32LE(child, offset + 76); directory.writeInt32LE(start, offset + 116);
    directory.writeUInt32LE(size, offset + 120);
  };
  entry(0, 'Root Entry', 5, -2, 0, 1);
  entry(1, 'WordDocument', 2, 0, 4096, -1, 2);
  entry(2, '0Table', 2, 8, 4096);
  const fat = Buffer.alloc(512, 255);
  for (let i = 0; i < 16; i++) fat.writeInt32LE(i === 7 || i === 15 ? -2 : i + 1, i * 4);
  fat.writeInt32LE(-2, 16 * 4); fat.writeInt32LE(-3, 17 * 4);
  return Buffer.concat([header, word, table, directory, fat]);
}

module.exports = { createDocx, createXlsx, createDoc };
