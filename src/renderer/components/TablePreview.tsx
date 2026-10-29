import type { PreviewSheet } from '../../shared/artifact-formats';

function columnName(index: number): string {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

export function TablePreview({ sheets, truncated = false, selected, onSelect }: {
  sheets: PreviewSheet[]; truncated?: boolean; selected: number; onSelect: (index: number) => void;
}) {
  const selectedIndex = selected < sheets.length ? selected : 0;
  const sheet = sheets[selectedIndex];
  const columns = sheet?.rows.reduce((max, row) => Math.max(max, row.length), 0) ?? 0;
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {sheets.length > 1 && <div role="tablist" aria-label="Workbook sheets" className="flex shrink-0 gap-2 overflow-x-auto p-2 border-b border-border">
        {sheets.map((value, index) => <button key={index} role="tab" aria-selected={index === selectedIndex}
          className={`px-2 py-1 rounded ${index === selectedIndex ? 'bg-accent text-surface' : 'text-fg-muted'}`}
          onClick={() => onSelect(index)}>{value.name}</button>)}
      </div>}
      {(truncated || sheet?.truncated) && <div role="status" className="px-3 py-2 text-xs text-warning">
        Limited preview: up to 20 sheets, 1,000 rows and 100 columns per sheet, 20,000 cells total. Long cell text may be shortened.
      </div>}
      <div className="overflow-auto flex-1 min-h-0">
        {!sheet?.rows.length ? <div className="p-4 text-fg-muted">This sheet is empty.</div> : (
          <table aria-label={sheet.name} className="artifact-table text-xs border-collapse">
            <thead><tr><th scope="col" aria-label="Row" />{Array.from({ length: columns }, (_, index) =>
              <th key={index} scope="col">{columnName(index)}</th>)}</tr></thead>
            <tbody>{sheet.rows.map((row, index) => <tr key={index}>
              <th scope="row">{index + 1}</th>{Array.from({ length: columns }, (_, column) =>
                <td key={column}><div>{row[column] ?? ''}</div></td>)}
            </tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="px-3 py-1 text-xs text-fg-muted border-t border-border">
        {sheet?.name ?? 'Workbook'} · {sheet?.rows.length ?? 0} rows shown · Formulas and links are never executed.
      </div>
    </div>
  );
}
