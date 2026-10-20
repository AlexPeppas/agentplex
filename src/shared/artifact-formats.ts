export const ARTIFACT_EXTENSIONS = {
  json: 'json', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', pdf: 'pdf',
  csv: 'table', tsv: 'table', docx: 'document', doc: 'document', xlsx: 'workbook',
  mmd: 'mermaid', mermaid: 'mermaid',
  txt: 'text', log: 'text', yaml: 'text', yml: 'text', xml: 'text', toml: 'text',
  ini: 'text', conf: 'text', config: 'text', env: 'text', jsonl: 'text', ndjson: 'text',
  js: 'text', jsx: 'text', ts: 'text', tsx: 'text', mjs: 'text', cjs: 'text',
  css: 'text', scss: 'text', py: 'text', rb: 'text', go: 'text', rs: 'text',
  java: 'text', c: 'text', h: 'text', cpp: 'text', hpp: 'text', cs: 'text',
  sql: 'text', sh: 'text', bash: 'text', zsh: 'text', ps1: 'text', bat: 'text', cmd: 'text',
  r: 'text',
} as const;

export type ArtifactKind = typeof ARTIFACT_EXTENSIONS[keyof typeof ARTIFACT_EXTENSIONS];

export function artifactKind(extension: string): ArtifactKind | null {
  const key = extension.replace(/^\./, '').toLowerCase();
  return Object.hasOwn(ARTIFACT_EXTENSIONS, key) ? ARTIFACT_EXTENSIONS[key as keyof typeof ARTIFACT_EXTENSIONS] : null;
}

export interface PreviewSheet {
  name: string;
  rows: string[][];
  truncated: boolean;
}

export type OfficePreview = { kind: 'document'; content: string; format: 'html' | 'text'; warnings: string[] }
  | { kind: 'workbook'; sheets: PreviewSheet[]; truncated: boolean };
