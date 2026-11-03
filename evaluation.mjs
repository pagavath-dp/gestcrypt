// Export outcomes and labels only; gesture signatures stay in memory.
export function beginReference(label, sig) {
  return [{ label, sig, result: 'REFERENCE' }];
}

export function csvCell(value) {
  let text = String(value);
  // Quoting alone does not stop spreadsheet programs interpreting a cell as a formula.
  if (/^[\s\x00-\x1f]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function trialsCsv(rows) {
  return ['trial,label,result', ...rows.map((row, index) =>
    [index + 1, row.label, row.result].map(csvCell).join(','))].join('\r\n') + '\r\n';
}
