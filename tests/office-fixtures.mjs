/**
 * ============================================================================
 * OFFICE FIXTURE BUILDERS (tests/office-fixtures.mjs)
 * ============================================================================
 * Builds small but structurally real documents so the parser tests exercise
 * the actual format readers (OOXML packages, RTF, PDF) instead of mocks.
 *
 * Deliberately generated rather than committed as binaries: the assertions say
 * which text must come out, so a fixture that no longer parses fails loudly
 * instead of rotting quietly in the repo. No dependencies on purpose - Artemis
 * has no test framework and this keeps `npm test` free to install.
 *
 * Formats covered here are the ones anydoc detects from content: docx, pptx,
 * xlsx, rtf and PDF (text and image-only).
 * ============================================================================
 */

import { deflateRawSync } from 'node:zlib';

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/* ------------------------------------------------------------------ zip */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** A minimal deflate ZIP (OOXML is always compressed) with fixed timestamps. */
export function buildZip(entries) {
  const dosTime = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.text, 'utf8');
    const data = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); // deflate
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const localPart = Buffer.concat(localParts);
  const centralPart = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

/* ----------------------------------------------------------- shared parts */

const PKG_RELS = (target) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
<Relationship Id="rId1" Type="${DOC_NS}/officeDocument" Target="${target}"/>
</Relationships>`;

const CONTENT_TYPES = (overrides, defaults = {}) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${Object.entries(defaults).map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('\n')}
${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('\n')}
</Types>`;

/* ------------------------------------------------------------------ docx */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;

const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Revenue grew </w:t></w:r>
<w:r><w:rPr><w:b/></w:rPr><w:t>14 percent</w:t></w:r>
<w:r><w:t xml:space="preserve"> versus last year, driven by </w:t></w:r>
<w:r><w:rPr><w:i/></w:rPr><w:t>enterprise renewals</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Regional Split</w:t></w:r></w:p>
<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>
<w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>EMEA</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>4.2M</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

export function buildDocx() {
  return buildZip([
    {
      name: '[Content_Types].xml',
      text: CONTENT_TYPES([
        ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
        ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
      ]),
    },
    { name: '_rels/.rels', text: PKG_RELS('word/document.xml') },
    {
      name: 'word/_rels/document.xml.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
<Relationship Id="rId1" Type="${DOC_NS}/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'word/styles.xml', text: DOCX_STYLES },
    { name: 'word/document.xml', text: DOCX_DOCUMENT },
  ]);
}

/* ------------------------------------------------------------------ pptx */

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export function buildPptx() {
  return buildZip([
    {
      name: '[Content_Types].xml',
      text: CONTENT_TYPES([
        ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
        ['/ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
      ]),
    },
    { name: '_rels/.rels', text: PKG_RELS('ppt/presentation.xml') },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
<Relationship Id="rId1" Type="${DOC_NS}/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/presentation.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${P} ${A} ${R}>
<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
    },
    {
      name: 'ppt/slides/slide1.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${P} ${A} ${R}>
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Artemis Roadmap</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>
<a:p><a:pPr marL="285750" indent="-285750"><a:buChar char="&#183;"/></a:pPr><a:r><a:t>Ship document parsing</a:t></a:r></a:p>
<a:p><a:pPr marL="285750" indent="-285750"><a:buChar char="&#183;"/></a:pPr><a:r><a:t>Add retrieval later</a:t></a:r></a:p>
</p:txBody></p:sp>
</p:spTree></p:cSld>
</p:sld>`,
    },
  ]);
}

/* ------------------------------------------------------------------ xlsx */

export function buildXlsx() {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return buildZip([
    {
      name: '[Content_Types].xml',
      text: CONTENT_TYPES([
        ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
        ['/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
      ]),
    },
    { name: '_rels/.rels', text: PKG_RELS('xl/workbook.xml') },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
<Relationship Id="rId1" Type="${DOC_NS}/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook ${S} xmlns:r="${DOC_NS}">
<sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${S}>
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Revenue</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>EMEA</t></is></c><c r="B2" t="inlineStr"><is><t>4.2M</t></is></c></row>
</sheetData>
</worksheet>`,
    },
  ]);
}

/* ------------------------------------------------------------------- rtf */

export function buildRtf() {
  return Buffer.from(
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\n' +
    '{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}\n' +
    '\\pard\\heading1\\b Sample Contract\\par\n' +
    '\\b0 This agreement is between \\i Artemis Ltd\\i0  and the Customer.\\par\n' +
    '\\pard The term runs for 12 months from the effective date.\\par\n}',
    'ascii'
  );
}

/* ------------------------------------------------------------------- pdf */

/** Assembles a classic cross-reference table PDF from bare objects. */
function buildPdf(objects) {
  const pdf = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let length = pdf[0].length;

  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from('\nendobj\n'),
    ]);
    pdf.push(chunk);
    length += chunk.length;
  });

  const xrefAt = length;
  const rows = objects.map((_, i) => `${String(offsets[i]).padStart(10, '0')} 00000 n `);
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows.join('\n')}\n` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    'ascii'
  );

  return Buffer.concat([...pdf, xref]);
}

/** A PDF stream object: dictionary, exact byte count, then the raw bytes. */
function streamObject(dictEntries, data) {
  return Buffer.concat([
    Buffer.from(`<< ${dictEntries} /Length ${data.length} >>\nstream\n`, 'ascii'),
    data,
    Buffer.from('endstream', 'ascii'),
  ]);
}

/** A page with real text operators - anydoc converts this locally. */
export function buildTextPdf() {
  const text = Buffer.from(
    'BT /F1 24 Tf 72 720 Td (Invoice 2026-1147) Tj ET\n' +
    'BT /F1 12 Tf 72 690 Td (Total due: 4200.00 EUR) Tj ET\n',
    'ascii'
  );

  return buildPdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', 'ascii'),
    streamObject('', text),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii'),
  ]);
}

/** A page that is only a picture: no text, so it needs OCR. */
export function buildScannedPdf() {
  const pixels = Buffer.alloc(8 * 8 * 3, 0xFF); // red 8x8 RGB, uncompressed
  const image = Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width 8 /Height 8 `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`, 'ascii'),
    pixels,
    Buffer.from('\nendstream', 'ascii'), // the EOL sits outside /Length
  ]);
  const content = Buffer.from('q 612 0 0 792 0 0 cm /Im1 Do Q\n', 'ascii');

  return buildPdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>', 'ascii'),
    image,
    streamObject('', content),
  ]);
}

/** Bytes that are not any document. */
export function buildGarbage() {
  return Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
}
