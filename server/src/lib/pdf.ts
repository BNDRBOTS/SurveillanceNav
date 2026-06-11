/**
 * Minimal from-scratch PDF 1.4 writer (no dependencies): text, rules,
 * filled rectangles, simple vector point maps, automatic pagination.
 * Produces valid PDFs (cross-reference table, Helvetica WinAnsi text)
 * sufficient for report and map-snapshot exports.
 */

interface PdfObj {
  id: number;
  body: string | Buffer;
}

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;

function escapePdfText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // strip characters outside latin-1 (WinAnsi font encoding)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

export class PdfBuilder {
  private pages: string[][] = [];
  private current: string[] = [];
  private y = PAGE_H - MARGIN;

  constructor(private title: string) {
    this.newPage();
  }

  private newPage(): void {
    this.current = [];
    this.pages.push(this.current);
    this.y = PAGE_H - MARGIN;
  }

  private ensureSpace(needed: number): void {
    if (this.y - needed < MARGIN) this.newPage();
  }

  /** rgb components 0..1 */
  setFill(r: number, g: number, b: number): void {
    this.current.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
  }

  text(str: string, opts: { size?: number; bold?: boolean; indent?: number; color?: [number, number, number] } = {}): void {
    const size = opts.size ?? 10;
    const lineHeight = size * 1.45;
    const maxChars = Math.floor((PAGE_W - 2 * MARGIN - (opts.indent ?? 0)) / (size * 0.55));
    const lines = wrapText(str, Math.max(20, maxChars));
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      const [r, g, b] = opts.color ?? [0.08, 0.1, 0.13];
      this.current.push(
        `BT /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ${MARGIN + (opts.indent ?? 0)} ${this.y.toFixed(1)} Td (${escapePdfText(line)}) Tj ET`,
      );
      this.y -= lineHeight;
    }
  }

  heading(str: string, level: 1 | 2 | 3 = 1): void {
    const sizes = { 1: 20, 2: 14, 3: 11.5 } as const;
    this.spacer(level === 1 ? 14 : 10);
    this.text(str, { size: sizes[level], bold: true, color: [0.02, 0.35, 0.28] });
    if (level === 1) this.rule();
  }

  spacer(pts = 8): void {
    this.y -= pts;
  }

  rule(): void {
    this.ensureSpace(8);
    this.current.push(
      `0.6 w 0.0 0.7 0.55 RG ${MARGIN} ${this.y.toFixed(1)} m ${PAGE_W - MARGIN} ${this.y.toFixed(1)} l S`,
    );
    this.y -= 10;
  }

  table(headers: string[], rows: string[][]): void {
    const colW = (PAGE_W - 2 * MARGIN) / headers.length;
    const cell = (txt: string, x: number, bold: boolean) =>
      `BT /${bold ? 'F2' : 'F1'} 8.5 Tf 0.08 0.1 0.13 rg ${x.toFixed(1)} ${this.y.toFixed(1)} Td (${escapePdfText(truncate(txt, Math.floor(colW / 4.4)))}) Tj ET`;
    this.ensureSpace(16);
    headers.forEach((h, i) => this.current.push(cell(h, MARGIN + i * colW, true)));
    this.y -= 13;
    for (const row of rows) {
      this.ensureSpace(13);
      row.forEach((v, i) => this.current.push(cell(v ?? '', MARGIN + i * colW, false)));
      this.y -= 12;
    }
    this.spacer(6);
  }

  /**
   * Simple vector map snapshot: plots points within a bbox onto a framed
   * canvas, color-coded; used for PDF map exports.
   */
  mapSnapshot(
    points: Array<{ lng: number; lat: number; color?: [number, number, number] }>,
    bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
    heightPts = 280,
  ): void {
    const w = PAGE_W - 2 * MARGIN;
    this.ensureSpace(heightPts + 20);
    const top = this.y;
    const bottom = top - heightPts;
    // frame + background
    this.current.push(
      `0.95 0.97 1.0 rg ${MARGIN} ${bottom.toFixed(1)} ${w} ${heightPts} re f`,
      `0.4 w 0.13 0.19 0.27 RG ${MARGIN} ${bottom.toFixed(1)} ${w} ${heightPts} re S`,
    );
    const spanLng = Math.max(1e-6, bbox.maxLng - bbox.minLng);
    const spanLat = Math.max(1e-6, bbox.maxLat - bbox.minLat);
    for (const p of points.slice(0, 4000)) {
      const x = MARGIN + ((p.lng - bbox.minLng) / spanLng) * w;
      const yy = bottom + ((p.lat - bbox.minLat) / spanLat) * heightPts;
      if (x < MARGIN || x > MARGIN + w || yy < bottom || yy > top) continue;
      const [r, g, b] = p.color ?? [0, 0.7, 0.55];
      this.current.push(
        `${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)} rg ${(x - 1.4).toFixed(1)} ${(yy - 1.4).toFixed(1)} 2.8 2.8 re f`,
      );
    }
    this.y = bottom - 14;
  }

  build(): Buffer {
    const objects: PdfObj[] = [];
    let nextId = 1;
    const alloc = () => nextId++;

    const fontRegular = alloc();
    const fontBold = alloc();
    objects.push({
      id: fontRegular,
      body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    });
    objects.push({
      id: fontBold,
      body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
    });

    const pageIds: number[] = [];
    const contentIds: number[] = [];
    for (const page of this.pages) {
      const content = page.join('\n');
      const cid = alloc();
      contentIds.push(cid);
      objects.push({
        id: cid,
        body: `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
      });
      pageIds.push(alloc());
    }

    const pagesId = alloc();
    pageIds.forEach((pid, i) => {
      objects.push({
        id: pid,
        body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`,
      });
    });
    objects.push({
      id: pagesId,
      body: `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    });

    const catalogId = alloc();
    objects.push({ id: catalogId, body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` });
    const infoId = alloc();
    objects.push({
      id: infoId,
      body: `<< /Title (${escapePdfText(this.title)}) /Producer (STN Lens of Light) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`,
    });

    objects.sort((a, b) => a.id - b.id);
    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    const offsets: number[] = [0];
    let pos = chunks[0]!.length;
    for (const obj of objects) {
      offsets[obj.id] = pos;
      const buf = Buffer.from(`${obj.id} 0 obj\n${obj.body}\nendobj\n`, 'latin1');
      chunks.push(buf);
      pos += buf.length;
    }
    const xrefPos = pos;
    let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
    for (let i = 1; i < nextId; i += 1) {
      xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

function wrapText(str: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const paragraph of str.split('\n')) {
    if (paragraph.length <= maxChars) {
      out.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line.length + word.length + 1 > maxChars) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}
