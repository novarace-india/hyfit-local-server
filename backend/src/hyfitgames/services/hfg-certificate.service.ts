import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';

export const fmtMs = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

export interface CertificateData {
  full_name: string;
  bib: string;
  city: string;
  edition: number;
  event_name: string;
  event_date: string | Date;
  total_ms: number | null;
  overall_rank: number | null;
  gender_rank: number | null;
  age_group: string | null;
  age_group_rank: number | null;
  serial: string;
}

// Streams a landscape A4 finisher certificate straight to the response.
// Ported from services/certificate.js.
@Injectable()
export class HfgCertificateService {
  streamCertificate(res: Response, d: CertificateData): void {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="HYFIT-${d.city}-${d.edition}-${d.bib}.pdf"`,
    );
    doc.pipe(res);

    const W = doc.page.width,
      H = doc.page.height;
    const RED = '#E10600',
      BLACK = '#0A0A0A',
      GREY = '#5a5a5a';

    // frame
    doc.rect(0, 0, W, H).fill('#FFFFFF');
    doc.rect(0, 0, W, 26).fill(RED);
    doc.rect(0, H - 26, W, 26).fill(BLACK);
    doc
      .lineWidth(2)
      .rect(30, 46, W - 60, H - 92)
      .stroke(BLACK);

    doc
      .fillColor(BLACK)
      .font('Helvetica-Bold')
      .fontSize(34)
      .text('HYFIT GAMES', 0, 80, { align: 'center', characterSpacing: 4 });
    doc
      .fillColor(RED)
      .fontSize(13)
      .text('RUN. LIFT. LIVE.', { align: 'center', characterSpacing: 3 });

    doc
      .moveDown(1.2)
      .fillColor(GREY)
      .font('Helvetica')
      .fontSize(14)
      .text('CERTIFICATE OF ACHIEVEMENT', {
        align: 'center',
        characterSpacing: 2,
      });
    doc
      .moveDown(0.4)
      .fillColor(GREY)
      .fontSize(11)
      .text('This is proudly presented to', { align: 'center' });

    doc
      .moveDown(0.5)
      .fillColor(BLACK)
      .font('Helvetica-Bold')
      .fontSize(30)
      .text(d.full_name.toUpperCase(), { align: 'center' });

    doc
      .moveDown(0.5)
      .fillColor(GREY)
      .font('Helvetica')
      .fontSize(12)
      .text(
        `for completing ${d.event_name} — Edition ${d.edition}, ${d.city}` +
          ` on ${new Date(d.event_date).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}`,
        { align: 'center' },
      );

    // stat band
    const stats: [string, string][] = [
      ['FINISH TIME', fmtMs(d.total_ms)],
      ['OVERALL', d.overall_rank ? `#${d.overall_rank}` : '—'],
      ['GENDER', d.gender_rank ? `#${d.gender_rank}` : '—'],
      [
        `AGE GROUP ${d.age_group || ''}`.trim(),
        d.age_group_rank ? `#${d.age_group_rank}` : '—',
      ],
      ['BIB', d.bib],
    ];
    const bandY = H - 190,
      cellW = (W - 160) / stats.length;
    stats.forEach(([label, value], i) => {
      const x = 80 + i * cellW;
      doc
        .fillColor(RED)
        .font('Helvetica-Bold')
        .fontSize(18)
        .text(String(value), x, bandY, { width: cellW, align: 'center' });
      doc
        .fillColor(GREY)
        .font('Helvetica')
        .fontSize(8.5)
        .text(label, x, bandY + 24, {
          width: cellW,
          align: 'center',
          characterSpacing: 1,
        });
    });

    doc
      .fillColor(GREY)
      .fontSize(8)
      .text(
        `Certificate No. ${d.serial}  ·  Verify at hyfitgames.com/verify`,
        0,
        H - 60,
        { align: 'center' },
      );

    doc.end();
  }
}
