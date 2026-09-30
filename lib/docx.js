// lib/docx.js — Minimal Markdown → DOCX writer.
// Emits a real .docx (OOXML zip) with no external dependency: headings, bold/italic,
// inline code, code blocks, bullets, numbered lists, quotes, rules.
// ponytail: bullets are "• " prefixed paragraphs rather than numbering.xml — Word renders
// them fine and it avoids a 40-line numbering part that could break the file. Swap in
// numbering.xml if native list continuation is ever needed.
// buildCvDocx(): CV được THIẾT KẾ (banner màu, header 2 cột với ô dán ảnh 3×4,
// khối liên hệ, heading mục màu + kẻ dòng, ngày tháng căn phải, kỹ năng 2 cột).
const zlib = require('zlib');

// ---------- zip ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zipSync(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);      // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ---------- markdown → runs ----------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Split a line into runs: **bold**, *italic*/_italic_, `code`
function inlineRuns(text, base = {}) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), ...base });
    const tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) runs.push({ text: tok.slice(2, -2), bold: true, ...base });
    else if (tok.startsWith('`')) runs.push({ text: tok.slice(1, -1), code: true, ...base });
    else runs.push({ text: tok.slice(1, -1), italic: true, ...base });
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), ...base });
  return runs.length ? runs : [{ text, ...base }];
}

function runXml(r) {
  if (r.tab) return `<w:r><w:tab/></w:r>`;
  const props = [];
  if (r.font) props.push(`<w:rFonts w:ascii="${r.font}" w:hAnsi="${r.font}" w:cs="${r.font}"/>`);
  if (r.bold) props.push('<w:b/>');
  if (r.italic) props.push('<w:i/>');
  if (r.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F1F5F9"/>');
  if (r.size) props.push(`<w:sz w:val="${r.size * 2}"/><w:szCs w:val="${r.size * 2}"/>`);
  if (r.color) props.push(`<w:color w:val="${r.color}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
}

// Paragraph with schema-ordered pPr (pBdr → tabs → spacing → ind → jc) + optional tab run
function cvPara(runs, { spacing = {}, indent = 0, align, border, tabs } = {}) {
  const pPr = [];
  if (border) pPr.push(`<w:pBdr>${border}</w:pBdr>`);
  if (tabs) pPr.push(`<w:tabs>${tabs}</w:tabs>`);
  const sp = [];
  if (spacing.before != null) sp.push(`w:before="${spacing.before}"`);
  if (spacing.after != null) sp.push(`w:after="${spacing.after}"`);
  if (sp.length) pPr.push(`<w:spacing ${sp.join(' ')}/>`);
  if (indent) pPr.push(`<w:ind w:left="${indent}"/>`);
  if (align) pPr.push(`<w:jc w:val="${align}"/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  return `<w:p>${pPrXml}${runs.map(runXml).join('')}</w:p>`;
}

function paraXml(runs, { spacing = {}, indent = 0, align } = {}) {
  const pPr = [];
  if (indent) pPr.push(`<w:ind w:left="${indent}"/>`);
  if (align) pPr.push(`<w:jc w:val="${align}"/>`);
  const sp = [];
  if (spacing.before != null) sp.push(`w:before="${spacing.before}"`);
  if (spacing.after != null) sp.push(`w:after="${spacing.after}"`);
  if (sp.length) pPr.push(`<w:spacing ${sp.join(' ')}/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  return `<w:p>${pPrXml}${runs.map(runXml).join('')}</w:p>`;
}

// Parse the markdown subset into Word paragraphs
function markdownToParagraphs(md) {
  const out = [];
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3);
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      for (const cl of code) {
        out.push(paraXml([{ text: cl || ' ', code: true, size: 9.5, color: '334155' }], { spacing: { after: 0 }, indent: 360 }));
      }
      out.push(paraXml([], { spacing: { after: 80 } }));
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CBD5E1"/></w:pBdr></w:pPr></w:p>');
      i++;
      continue;
    }

    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const sizes = { 1: 20, 2: 16, 3: 13.5, 4: 12, 5: 11, 6: 11 };
      out.push(paraXml(inlineRuns(h[2].replace(/\*\*/g, ''), { bold: true, size: sizes[level], color: level <= 2 ? '1E293B' : '334155' }), { spacing: { before: 240, after: 100 } }));
      i++;
      continue;
    }

    // bullet
    const b = /^\s*[-*+•]\s+(.*)$/.exec(line);
    if (b) {
      out.push(paraXml([{ text: '•  ' }, ...inlineRuns(b[1])], { indent: 360, spacing: { after: 60 } }));
      i++;
      continue;
    }

    // numbered
    const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (n) {
      out.push(paraXml([{ text: `${n[1]}.  ` }, ...inlineRuns(n[2])], { indent: 360, spacing: { after: 60 } }));
      i++;
      continue;
    }

    // quote
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push(paraXml(inlineRuns(q[1], { italic: true, color: '475569' }), { indent: 360, spacing: { after: 80 } }));
      i++;
      continue;
    }

    // blank
    if (!line.trim()) {
      out.push(paraXml([], { spacing: { after: 100 } }));
      i++;
      continue;
    }

    // paragraph
    out.push(paraXml(inlineRuns(line), { spacing: { after: 120 } }));
    i++;
  }
  return out.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// Build a .docx buffer from a title + markdown body
function buildDocx(title, markdown) {
  const body = [
    paraXml(inlineRuns(title || '', { bold: true, size: 22, color: '4338CA' }), { spacing: { after: 240 } }),
    markdownToParagraphs(markdown),
  ].join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body></w:document>`;

  return zipSync([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

// ---------- CV thiết kế: parse markdown CV → structured → OOXML có bố cục ----------
// Parse output của rewriteCV (Markdown: # Tên, **Chức danh**, ## MỤC, bullet, **job — dates**)
function parseCvMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = { name: '', title: '', contact: [], sections: [] };
  let cur = null;
  const CONTACT_RE = /THÔNG TIN|CÁ NHÂN|LIÊN HỆ|CONTACT|PERSONAL/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^#\s+(.+)/.exec(line))) { out.name = m[1].replace(/\*\*/g, '').trim(); continue; }
    if ((m = /^#{2,3}\s+(.+)/.exec(line))) {
      cur = { title: m[1].replace(/\*\*/g, '').trim(), items: [], contactLike: CONTACT_RE.test(m[1]) };
      out.sections.push(cur);
      continue;
    }
    if (!cur) {
      if (/^\*\*[^*]+\*\*:?$/.test(line) && !out.title) out.title = line.replace(/\*\*/g, '').replace(/:$/, '').trim();
      else if (/^[-*+•]\s+/.test(line)) out.contact.push(line.replace(/^[-*+•]\s+/, ''));
      else if (!out.name) out.name = line.replace(/\*\*/g, '').trim();
      continue;
    }
    if (/^[-*+•]\s+/.test(line)) { cur.items.push({ type: 'bullet', text: line.replace(/^[-*+•]\s+/, '') }); continue; }
    if (/^\*\*/.test(line)) {
      // Dòng mở đầu bằng bold: "**Công ty** — 08/2020 - 08/2025" hoặc "**Công ty — dates**"
      // → job (căn phải phần ngày tháng). Nếu phần ngoài bold không phải ngày → para thường.
      const inner = line.replace(/\*\*/g, '').replace(/:$/, '').trim();
      const fullyBold = /^\*\*[^*]+\*\*:?$/.test(line);
      const DATE = /(\d{2}\/\d{4}\s*[-–]\s*(?:\d{2}\/\d{4}|nay|hiện tại)|\d{4}\s*[-–]\s*(?:\d{4}|nay|hiện tại)|\d{1,2}\/\d{4}(?:\s*[-–]\s*\d{4})?)/i;
      const dm = DATE.exec(inner);
      if (fullyBold || (dm && dm.index > 2)) {
        let left = inner, right = '';
        if (dm && dm.index > 2) {
          right = inner.slice(dm.index).trim();
          left = inner.slice(0, dm.index).trim().replace(/[\s—–\-]+$/, '');
        }
        cur.items.push({ type: 'job', left, right });
        continue;
      }
      cur.items.push({ type: 'para', text: line });
      continue;
    }
    cur.items.push({ type: 'para', text: line });
  }
  // Gộp các mục kiểu thông tin cá nhân vào contact (hiển thị ở header, không render thành mục)
  const bodySections = [];
  for (const s of out.sections) {
    if (s.contactLike) for (const it of s.items) out.contact.push(it.type === 'bullet' ? it.text : it.text);
    else bodySections.push(s);
  }
  out.sections = bodySections;
  // Fallback: chưa có contact nào → thử trích email/phone từ toàn bộ markdown
  if (!out.contact.length) {
    const email = (md.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
    const phone = (md.match(/(?:\+84|0)(?:[\s.\-]?\d){8,10}/) || [])[0];
    if (email) out.contact.push(`Email: ${email}`);
    if (phone) out.contact.push(`Điện thoại: ${phone}`);
  }
  return out;
}

const CV_FONT = 'Calibri';
const CV_ACCENT = '4F46E5';
const CV_ACCENT_SOFT = 'EEF2FF';
const CV_DARK = '1E293B';
const CV_MUTED = '64748B';
const NO_BORDERS = '<w:tblBorders><w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/></w:tblBorders>';
const ZERO_MAR = '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>';

function cvTable({ cols, rows }) {
  return `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/>${NO_BORDERS}${ZERO_MAR}<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${cols.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

// Một hàng = nhiều cell trong CÙNG <w:tr> (cvCell chỉ trả <w:tc>)
function cvRow(cells, { height } = {}) {
  const trPr = height ? `<w:trPr><w:trHeight w:val="${height}" w:hRule="atLeast"/></w:trPr>` : '';
  return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
}

function cvCell(width, paras, { borders = '', shade = '', vAlign = 'top' } = {}) {
  const tcPr = `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${borders}${shade}<w:vAlign w:val="${vAlign}"/></w:tcPr>`;
  return `<w:tc>${tcPr}${paras.join('')}</w:tc>`;
}

const PHOTO_BORDERS = '<w:tcBorders>' +
  '<w:top w:val="dashed" w:sz="10" w:space="0" w:color="A5B4FC"/>' +
  '<w:left w:val="dashed" w:sz="10" w:space="0" w:color="A5B4FC"/>' +
  '<w:bottom w:val="dashed" w:sz="10" w:space="0" w:color="A5B4FC"/>' +
  '<w:right w:val="dashed" w:sz="10" w:space="0" w:color="A5B4FC"/>' +
  '</w:tcBorders>';

function cvSectionHeading(title) {
  return cvPara(
    [{ text: String(title).toUpperCase(), bold: true, size: 11, color: CV_ACCENT, font: CV_FONT }],
    {
      border: `<w:bottom w:val="single" w:sz="8" w:space="2" w:color="${CV_ACCENT}"/>`,
      spacing: { before: 260, after: 120 },
    }
  );
}

// Build a designed CV .docx from CV markdown. Fallback về buildDocx nếu parse rỗng.
function buildCvDocx(markdown, { name: fallbackName = 'CV' } = {}) {
  const cv = parseCvMarkdown(markdown);
  if (!cv.sections.length) return buildDocx(cv.name || fallbackName, markdown);

  const body = [];

  // 1. Banner màu sát lề trên
  body.push(cvTable({
    cols: [9638],
    rows: [cvRow([cvCell(9638, [cvPara([{ text: ' ', size: 2, font: CV_FONT }], { spacing: { after: 0 } })], { shade: `<w:shd w:val="clear" w:fill="${CV_ACCENT}"/>` })], { height: 110 })],
  }));
  body.push(cvPara([], { spacing: { after: 120 } }));

  // 2. Header 2 cột: trái = tên + chức danh + liên hệ; phải = ô dán ảnh 3×4
  const leftParas = [
    cvPara([{ text: cv.name || fallbackName, bold: true, size: 30, color: CV_DARK, font: CV_FONT }], { spacing: { after: 60 } }),
  ];
  if (cv.title) leftParas.push(cvPara([{ text: cv.title, size: 12.5, color: CV_ACCENT, font: CV_FONT }], { spacing: { after: 120 } }));
  for (const c of cv.contact.slice(0, 6)) {
    leftParas.push(cvPara([{ text: c, size: 9.5, color: CV_MUTED, font: CV_FONT }], { spacing: { after: 20 } }));
  }
  const photoParas = [
    cvPara([{ text: '📷', size: 22, font: CV_FONT }], { align: 'center', spacing: { after: 60 } }),
    cvPara([{ text: 'Ô dán ảnh 3×4', bold: true, size: 9.5, color: CV_ACCENT, font: CV_FONT }], { align: 'center', spacing: { after: 30 } }),
    cvPara([{ text: 'Bấm vào ô này → Insert → Pictures → chọn ảnh thẻ', size: 8, color: CV_MUTED, font: CV_FONT }], { align: 'center', spacing: { after: 0 } }),
  ];
  body.push(cvTable({
    cols: [6540, 3098],
    rows: [cvRow([
      cvCell(6540, leftParas),
      cvCell(3098, photoParas, { borders: PHOTO_BORDERS, shade: `<w:shd w:val="clear" w:fill="${CV_ACCENT_SOFT}"/>`, vAlign: 'center' }),
    ], { height: 2600 })],
  }));
  body.push(cvPara([], { spacing: { after: 60 } }));

  // 3. Các mục nội dung
  for (const s of cv.sections) {
    body.push(cvSectionHeading(s.title));
    const isSkill = /KỸ NĂNG|SKILL/i.test(s.title);
    const bullets = s.items.filter(i => i.type === 'bullet');
    // Mục kỹ năng: bullet ngắn → xếp 2 cột cho gọn
    if (isSkill && bullets.length >= 4 && bullets.every(b => b.text.length < 70)) {
      const half = Math.ceil(bullets.length / 2);
      const colA = bullets.slice(0, half), colB = bullets.slice(half);
      const cellParas = list => list.map(b => cvPara(
        [{ text: '•  ', color: CV_ACCENT, font: CV_FONT, bold: true }, ...inlineRuns(b.text, { size: 10.5, color: CV_DARK, font: CV_FONT })],
        { spacing: { after: 50 } }
      ));
      body.push(cvTable({
        cols: [4819, 4819],
        rows: [cvRow([cvCell(4819, cellParas(colA)), cvCell(4819, cellParas(colB))])],
      }));
      body.push(cvPara([], { spacing: { after: 40 } }));
    } else {
      for (const it of s.items) {
        if (it.type === 'job') {
          const runs = [{ text: it.left, bold: true, size: 11, color: CV_DARK, font: CV_FONT }];
          if (it.right) runs.push({ tab: true }, { text: it.right, size: 9.5, color: CV_MUTED, font: CV_FONT });
          body.push(cvPara(runs, { tabs: `<w:tab w:val="right" w:pos="9638"/>`, spacing: { before: 140, after: 40 } }));
        } else if (it.type === 'bullet') {
          body.push(cvPara(
            [{ text: '•  ', color: CV_ACCENT, font: CV_FONT, bold: true }, ...inlineRuns(it.text, { size: 10.5, color: CV_DARK, font: CV_FONT })],
            { indent: 240, spacing: { after: 50 } }
          ));
        } else {
          body.push(cvPara(inlineRuns(it.text, { size: 10.5, color: CV_DARK, font: CV_FONT }), { spacing: { after: 60 } }));
        }
      }
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body></w:document>`;

  return zipSync([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

module.exports = { buildDocx, buildCvDocx, parseCvMarkdown };
