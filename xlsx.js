// Small XLSX reader for the date / time / staff availability table.
// ZIP decompression and XML parsing use browser APIs only.
window.readShiftWorkbook = async (buffer) => {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const invalid = () => new Error('Excel ファイルの形式を読み取れません。通常の .xlsx ファイルを選択してください。');
  if (bytes.length < 22) throw invalid();
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < minimum) throw invalid();
  const entries = new Map();
  let offset = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const length = view.getUint16(offset + 28, true);
    entries.set(decoder.decode(bytes.subarray(offset + 46, offset + 46 + length)), {
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      size: view.getUint32(offset + 20, true),
      unpacked: view.getUint32(offset + 24, true),
      offset: view.getUint32(offset + 42, true),
    });
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  async function xml(path, optional = false) {
    const entry = entries.get(path);
    if (!entry) {
      if (optional) return null;
      throw invalid();
    }
    if (entry.flags & 1 || entry.unpacked > 20 * 1024 * 1024) throw invalid();
    const start = entry.offset;
    if (start + 30 > bytes.length || view.getUint32(start, true) !== 0x04034b50) throw invalid();
    const dataStart = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
    if (dataStart + entry.size > bytes.length) throw invalid();
    let data = bytes.subarray(dataStart, dataStart + entry.size);
    if (entry.method === 8) {
      let decompressor;
      try { decompressor = new DecompressionStream('deflate-raw'); }
      catch { throw new Error('このブラウザでは Excel を展開できません。最新のブラウザを使用してください。'); }
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(decompressor)).arrayBuffer());
    } else if (entry.method !== 0) throw invalid();
    if (data.length !== entry.unpacked) throw invalid();
    const document = new DOMParser().parseFromString(decoder.decode(data), 'application/xml');
    if (document.querySelector('parsererror')) throw invalid();
    return document;
  }
  const elements = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));
  const stringsXml = await xml('xl/sharedStrings.xml', true);
  const strings = stringsXml ? elements(stringsXml, 'si').map((si) => elements(si, 't').map((t) => t.textContent).join('')) : [];
  const workbook = await xml('xl/workbook.xml');
  const relationships = await xml('xl/_rels/workbook.xml.rels');
  const paths = new Map(elements(relationships, 'Relationship').map((rel) => [rel.getAttribute('Id'), rel.getAttribute('Target')]));
  const date1904 = elements(workbook, 'workbookPr')[0]?.getAttribute('date1904');
  const epoch = date1904 === '1' || date1904 === 'true' ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const result = { months: [], days: {}, staff: {} };
  for (const sheet of elements(workbook, 'sheet')) {
    const match = /^(\d{4})年(\d{1,2})月$/.exec(sheet.getAttribute('name'));
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) throw invalid();
    const target = paths.get(sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    if (!target) throw invalid();
    const path = new URL(target, 'https://xlsx.local/xl/workbook.xml').pathname.slice(1);
    const document = await xml(path);
    const rows = elements(document, 'row').map((row) => {
      const cells = {};
      for (const cell of elements(row, 'c')) {
        const column = cell.getAttribute('r')?.replace(/\d+$/, '');
        const raw = elements(cell, 'v')[0]?.textContent ?? '';
        const type = cell.getAttribute('t');
        cells[column] = (type === 's' ? strings[Number(raw)] : type === 'inlineStr'
          ? elements(cell, 't').map((t) => t.textContent).join('') : raw)?.trim() ?? '';
      }
      return cells;
    });
    const headerIndex = rows.findIndex((row) => row.A === '日付' && row.B === '時間');
    if (headerIndex < 0) throw new Error(`${sheet.getAttribute('name')} に「日付」「時間」の見出しがありません。`);
    const staff = Object.entries(rows[headerIndex]).filter(([column, name]) => column !== 'A' && column !== 'B' && name && name !== '備考');
    if (!staff.length) throw new Error('スタッフ名が見つかりません。');
    let dateKey = '';
    let slots = 0;
    for (const row of rows.slice(headerIndex + 1)) {
      if (row.A) {
        if (!/^\d+(\.\d+)?$/.test(row.A)) { dateKey = ''; continue; }
        const date = new Date(epoch + Math.floor(Number(row.A)) * 86400000);
        if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month) throw new Error('シート名と日付が一致しません。');
        dateKey = date.toISOString().slice(0, 10);
      }
      if (!dateKey || !row.B || !/^\d+(\.\d+)?$/.test(row.B)) continue;
      const timeValue = Number(row.B);
      if (timeValue < 0 || timeValue >= 1) throw new Error('時間セルを読み取れません。');
      const minutes = Math.round(timeValue * 1440);
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const available = [];
      for (const [column, name] of staff) {
        const value = row[column] ?? '';
        if (['', '○', '◯', '〇'].includes(value)) available.push(name);
        else if (!['×', '✕', '✖', 'x', 'X'].includes(value)) {
          throw new Error(`${sheet.getAttribute('name')} の ${dateKey} ${time} に未対応の希望記号「${value}」があります。`);
        }
      }
      (result.days[dateKey] ??= []).push({ time, names: available });
      slots++;
    }
    if (slots) {
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      result.months.push(monthKey);
      result.staff[monthKey] = staff.map(([, name]) => name);
    }
  }
  if (!result.months.length) throw new Error('「2026年10月」のような名前の月別シートに勤務希望が必要です。');
  result.months.sort();
  return result;
};
