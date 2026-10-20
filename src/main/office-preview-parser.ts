import * as yauzl from 'yauzl';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import WordExtractor from 'word-extractor';
import sanitizeHtml from 'sanitize-html';
import type { OfficePreview, PreviewSheet } from '../shared/artifact-formats';

// Inspect every inflated entry before handing a ZIP-based Office file to a parser.
async function validateArchive(bytes: Buffer, required: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      let count = 0, total = 0, found = false;
      const fail = (reason: Error) => { zip.close(); reject(reason); };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        count++;
        total += entry.uncompressedSize;
        if (count > 2000 || total > 40 * 1024 * 1024) {
          fail(new Error('Office archive exceeds 2000 entries or 40 MiB expanded content')); return;
        }
        if (entry.isEncrypted()) { fail(new Error('Encrypted Office files cannot be previewed')); return; }
        found ||= entry.fileName === required;
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(streamError || new Error('Cannot read Office archive entry')); return; }
          let inflated = 0;
          stream.on('data', chunk => {
            inflated += chunk.length;
            if (inflated > entry.uncompressedSize || inflated > 40 * 1024 * 1024) {
              stream.destroy(new Error('Office archive entry exceeds its declared size'));
            }
          });
          stream.on('error', fail);
          stream.on('end', () => zip.readEntry());
          stream.resume();
        });
      });
      zip.on('end', () => { zip.close(); if (found) resolve(); else reject(new Error(`Office archive is missing ${required}`)); });
      zip.readEntry();
    });
  });
}

function bounded(content: string): string {
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('Extracted document exceeds the 2 MiB text preview limit');
  return content;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if ('formula' in value || 'sharedFormula' in value) return value.result === undefined
    ? '[Formula: no cached result]' : cellText(value.result);
  if ('richText' in value) return value.richText.map(run => run.text).join('');
  if ('text' in value) return value.text;
  if ('error' in value) return value.error;
  return '';
}

export async function parseOfficePreview(bytes: Buffer, extension: string): Promise<OfficePreview> {
  if (extension === '.doc') {
    if (bytes.length < 512 || !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
      throw new Error('File is not a legacy Word DOC document');
    }
    // The legacy parser allocates from these header fields before reading sectors.
    const sectorShift = bytes.readUInt16LE(30);
    const sectors = Math.max(0, Math.floor(bytes.length / 2 ** sectorShift) - 1);
    if (bytes.readUInt16LE(28) !== 0xfffe || ![9, 12].includes(sectorShift)
      || bytes.readUInt16LE(32) !== 6 || bytes.readUInt32LE(56) !== 4096
      || bytes.readUInt32LE(44) === 0
      || [44, 64, 72].some(offset => bytes.readUInt32LE(offset) > sectors)) {
      throw new Error('Invalid legacy Word compound-document header or allocation size');
    }
    const document = await new WordExtractor().extract(bytes);
    const content = [document.getHeaders({ includeFooters: false }), document.getBody(), document.getFootnotes(),
      document.getEndnotes(), document.getTextboxes({ includeHeadersAndFooters: false }), document.getFooters()]
      .filter(Boolean).join('\n\n');
    return { kind: 'document', format: 'text', content: bounded(content),
      warnings: ['Legacy DOC is shown as extracted text, without its original page layout. Macros are not executed.'] };
  }
  if (extension !== '.docx' && extension !== '.xlsx') throw new Error('Unsupported Office document');
  await validateArchive(bytes, extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml');
  if (extension === '.docx') {
    const result = await mammoth.convertToHtml({ buffer: bytes }, {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    });
    const content = sanitizeHtml(bounded(result.value), {
      allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
        'tr', 'td', 'th', 'strong', 'em', 'u', 's', 'sup', 'sub', 'br', 'blockquote', 'pre', 'code'],
      allowedAttributes: {}, disallowedTagsMode: 'discard',
    });
    return { kind: 'document', content, format: 'html',
      warnings: ['Document preview preserves text structure, not exact pagination. Images, links and embedded objects are disabled.',
        ...result.messages.slice(0, 20).map(message => bounded(message.message))] };
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer, { ignoreNodes: ['drawing', 'picture', 'extLst', 'dataValidations', 'conditionalFormatting'] });
  let remainingCells = 20000;
  let remainingText = 1024 * 1024;
  const sheets: PreviewSheet[] = [];
  for (const worksheet of workbook.worksheets.slice(0, 20)) {
    const rows: string[][] = [];
    const columns = Math.min(worksheet.columnCount, 100);
    let truncated = worksheet.rowCount > 1000 || worksheet.columnCount > 100;
    for (let row = 1; row <= Math.min(worksheet.rowCount, 1000); row++) {
      if (remainingCells < columns) { truncated = true; break; }
      const values: string[] = [];
      for (let column = 1; column <= columns; column++) {
        const text = cellText(worksheet.getRow(row).getCell(column).value);
        if (text.length > 10000 || text.length > remainingText) truncated = true;
        const limited = text.slice(0, Math.min(10000, remainingText));
        remainingText -= limited.length;
        values.push(limited);
      }
      rows.push(values);
      remainingCells -= columns;
    }
    sheets.push({ name: worksheet.name, rows, truncated });
  }
  return { kind: 'workbook', sheets, truncated: workbook.worksheets.length > 20 || sheets.some(sheet => sheet.truncated) };
}
