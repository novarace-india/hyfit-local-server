import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HjudgeCertificatesService } from './services/hjudge-certificates.service';

/* Certificate templates.
 *
 * Five behaviours here are the ones that would be expensive to get wrong on an
 * event day, and none of them is visible from the route signatures:
 *
 *   1. RESOLUTION — a design that NAMES the athlete's contest beats the event
 *      default, and an unpublished one is not a candidate for either. Get the
 *      ordering wrong and every Elite finisher silently receives the generic
 *      certificate.
 *   2. PARTIAL UPDATE — one PUT serves the editor saving a layout, the list
 *      renaming a template, the publish toggle and re-scoping coverage. If an
 *      absent field were written as a default, renaming would erase the design.
 *   3. COVERAGE AS A SET — one design covers any number of contests, and a new
 *      set REPLACES the old one. An add-only write would leave no way to
 *      un-cover a contest.
 *   4. CONSTRAINT MESSAGES — the database owns "one default per event" and
 *      "one template per contest", and both must reach the operator as a
 *      sentence they can act on rather than as a 500.
 *   5. THE UPLOAD PREFIX — the assets bucket serves three public prefixes and
 *      403s everything else, so a certificate written outside them cannot be
 *      drawn by the page that has to draw it.
 */

const EVENT = '11111111-1111-1111-1111-111111111111';
const TEMPLATE = '22222222-2222-2222-2222-222222222222';

type Call = { sql: string; params: unknown[] };

/** Stands in for the pool. `rows` is what the next query answers with. */
function harness(
  answer: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number },
) {
  const calls: Call[] = [];
  const uploads: { prefix: string; contentType: string; name?: string }[] = [];
  let txDepth = 0;
  let maxTxDepth = 0;
  /** Calls made inside a transaction, so a test can prove they were together. */
  const inTx: Call[] = [];

  const run = async (sql: string, params: unknown[] = []) => {
    const call = { sql, params };
    calls.push(call);
    if (txDepth > 0) inTx.push(call);
    const out = answer(sql, params);
    return { rows: out.rows, rowCount: out.rowCount ?? out.rows.length };
  };

  const db = {
    q: run,
    q1: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return answer(sql, params).rows[0] ?? null;
    },
    // The real one opens a client, BEGINs and rolls back on a throw. Rolling
    // back is the database's job; what these tests care about is that the
    // service does its column write and its coverage write inside ONE of these.
    tx: async (fn: (client: any) => Promise<any>) => {
      txDepth += 1;
      maxTxDepth = Math.max(maxTxDepth, txDepth);
      try {
        return await fn({ query: run });
      } finally {
        txDepth -= 1;
      }
    },
  };

  const s3 = {
    uploadFile: async (
      _buffer: Buffer,
      contentType: string,
      prefix: string,
      extension: string,
      name?: string,
    ) => {
      uploads.push({ prefix, contentType, name });
      return `https://bucket.s3.ap-south-1.amazonaws.com/${prefix}/${name}${extension}`;
    },
  };

  const service = new HjudgeCertificatesService(db as any, s3 as any);
  return { service, calls, uploads, inTx, txCount: () => maxTxDepth };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: TEMPLATE,
  event_id: EVENT,
  name: 'Event certificate',
  is_default: true,
  contests: [],
  background_url: 'https://bucket/art.png',
  schema: { fields: [{ id: 'f1' }] },
  is_published: true,
  ...over,
});

/** A constraint violation as `pg` reports one. */
const violation = (constraint: string, detail = '') => {
  const err: any = new Error('constraint violated');
  err.constraint = constraint;
  err.detail = detail;
  return err;
};

const coverageInsert = (calls: Call[]) =>
  calls.find((c) => /INSERT INTO hyfit_v2\.certificate_template_contests/.test(c.sql));
const coverageDelete = (calls: Call[]) =>
  calls.find((c) => /DELETE FROM hyfit_v2\.certificate_template_contests/.test(c.sql));

describe('HYFIT certificate templates', () => {
  describe('resolving the design a finisher prints on', () => {
    it('prefers a design naming the contest over the event default', async () => {
      // Both are asked for in one query and separated by the ORDER BY, because
      // the database is what decides this — a reversed clause is invisible at
      // the call site and would hand every Elite finisher the generic design.
      const { service, calls } = harness(() => ({
        rows: [row({ is_default: false, matched_contest: true })],
      }));

      const template = await service.publicTemplate(EVENT, 'Male Open');

      expect(template?.matched_contest).toBe(true);
      expect(calls[0].sql).toMatch(
        /ORDER BY \(cov\.template_id IS NOT NULL\) DESC/,
      );
      expect(calls[0].params).toEqual([EVENT, 'Male Open']);
    });

    it('considers only a named contest or the default, never anything else', async () => {
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.publicTemplate(EVENT, 'Male Open');

      expect(calls[0].sql).toMatch(
        /AND \(cov\.template_id IS NOT NULL OR t\.is_default\)/,
      );
    });

    it('never offers an unpublished design', async () => {
      const { service, calls } = harness(() => ({ rows: [] }));

      expect(await service.publicTemplate(EVENT, 'Male Open')).toBeNull();
      expect(calls[0].sql).toMatch(/AND t\.is_published/);
    });

    it('matches the contest through contest_key, not the raw spelling', async () => {
      // The feed writes one contest as "Male Open", "MALE OPEN" and
      // "Male  Open" depending on who typed it; a raw comparison would miss
      // two thirds of the field.
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.publicTemplate(EVENT, 'MALE  OPEN');

      expect(calls[0].sql).toMatch(
        /hyfit_v2\.contest_key\(cov\.contest\) = hyfit_v2\.contest_key\(\$2\)/,
      );
    });

    it('treats a missing contest as the event default rather than as null', async () => {
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.publicTemplate(EVENT, undefined);

      expect(calls[0].params[1]).toBe('');
    });
  });

  describe('coverage', () => {
    it('covers several contests with one design', async () => {
      const { service, calls } = harness((sql) =>
        /^\s*INSERT INTO hyfit_v2\.certificate_templates/.test(sql)
          ? { rows: [{ id: TEMPLATE }] }
          : { rows: [row()] },
      );

      await service.create(EVENT, {
        contests: ['Male Open', 'Female Open', 'Masters'],
      });

      expect(coverageInsert(calls)!.params[2]).toEqual([
        'Male Open',
        'Female Open',
        'Masters',
      ]);
    });

    it('replaces the set rather than adding to it', async () => {
      // Clearing a checkbox in the console has to remove that contest; an
      // add-only write would leave no way to un-cover one.
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.update(EVENT, TEMPLATE, { contests: ['Masters'] });

      expect(coverageDelete(calls)).toBeDefined();
      expect(coverageInsert(calls)!.params[2]).toEqual(['Masters']);
    });

    it('clears coverage when sent an empty list, without an empty insert', async () => {
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.update(EVENT, TEMPLATE, { contests: [] });

      expect(coverageDelete(calls)).toBeDefined();
      expect(coverageInsert(calls)).toBeUndefined();
    });

    it('leaves coverage alone when the caller did not mention it', async () => {
      // Publishing a design must not silently un-cover every contest it had.
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.update(EVENT, TEMPLATE, { is_published: true });

      expect(coverageDelete(calls)).toBeUndefined();
      expect(coverageInsert(calls)).toBeUndefined();
    });

    it('writes the columns and the coverage in one transaction', async () => {
      // A template that took its new name but not its new contests — or was
      // published while its coverage insert failed — is a state the console
      // never asked for and cannot see.
      const { service, inTx, txCount } = harness((sql) =>
        /^\s*INSERT INTO hyfit_v2\.certificate_templates/.test(sql)
          ? { rows: [{ id: TEMPLATE }] }
          : { rows: [row()] },
      );

      await service.update(EVENT, TEMPLATE, {
        name: 'Podium',
        contests: ['Masters'],
      });

      expect(txCount()).toBe(1);
      expect(inTx.some((c) => /^UPDATE/.test(c.sql.trim()))).toBe(true);
      expect(
        inTx.some((c) =>
          /INSERT INTO hyfit_v2\.certificate_template_contests/.test(c.sql),
        ),
      ).toBe(true);
    });

    it('drops blanks and collapses contests that differ only in spelling', async () => {
      // "Male Open" and "MALE  OPEN" in one request are one contest. Left in,
      // they would hit the unique index and be reported to the operator as a
      // clash with some other template, which is not what happened.
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.update(EVENT, TEMPLATE, {
        contests: ['Male Open', 'MALE  OPEN', '   ', 'Masters'],
      });

      expect(coverageInsert(calls)!.params[2]).toEqual(['Male Open', 'Masters']);
    });

    it('refuses coverage that is not a list', async () => {
      const { service } = harness(() => ({ rows: [row()] }));

      await expect(
        service.update(EVENT, TEMPLATE, { contests: 'Male Open' as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('saving a design', () => {
    it('writes only the fields the caller sent', async () => {
      const { service, calls } = harness(() => ({ rows: [row({ name: 'Podium' })] }));

      await service.update(EVENT, TEMPLATE, { name: 'Podium' });

      const update = calls.find((c) => /^UPDATE/.test(c.sql.trim()))!;
      const setClause = /SET ([\s\S]*?)\s+WHERE/.exec(update.sql)![1];
      expect(setClause).toBe('name = $3');
      // The layout, the artwork and the publish flag are untouched by a rename.
      expect(setClause).not.toMatch(/schema/);
      expect(setClause).not.toMatch(/background_url/);
      expect(setClause).not.toMatch(/is_published/);
    });

    it('stores the layout as JSON', async () => {
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.update(EVENT, TEMPLATE, {
        schema: { fields: [{ id: 'f1' }], canvas: { width: 794, height: 562 } },
      });

      const update = calls.find((c) => /^UPDATE/.test(c.sql.trim()))!;
      expect(JSON.parse(String(update.params[2]))).toEqual({
        fields: [{ id: 'f1' }],
        canvas: { width: 794, height: 562 },
      });
    });

    it('reads the template back when the caller sent nothing to change', async () => {
      const { service, calls } = harness(() => ({ rows: [row()] }));

      await service.update(EVENT, TEMPLATE, {});

      expect(calls.every((c) => !/^UPDATE/.test(c.sql.trim()))).toBe(true);
    });

    it('404s an update aimed at a template this event does not have', async () => {
      const { service } = harness(() => ({ rows: [], rowCount: 0 }));

      await expect(
        service.update(EVENT, TEMPLATE, { name: 'Podium' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s a coverage-only edit on a template this event does not have', async () => {
      // The coverage path takes a different branch to the column path, and it
      // must not write child rows for a template belonging to another event.
      const { service, calls } = harness(() => ({ rows: [], rowCount: 0 }));

      await expect(
        service.update(EVENT, TEMPLATE, { contests: ['Masters'] }),
      ).rejects.toThrow(NotFoundException);
      expect(coverageDelete(calls)).toBeUndefined();
    });
  });

  describe('what the operator is told', () => {
    it('turns the publish constraint into an instruction, not a 500', async () => {
      const { service } = harness(() => {
        throw violation('hyfit_v2_cert_templates_publishable');
      });

      await expect(
        service.update(EVENT, TEMPLATE, { is_published: true }),
      ).rejects.toThrow(/background.*at least one field/i);
    });

    it('names the contest another template already covers', async () => {
      // A dozen checkboxes and a message naming none of them is not an error
      // an operator can act on.
      const { service } = harness(() =>
        (() => {
          throw violation(
            'hyfit_v2_cert_contests_event_contest',
            'Key (event_id, contest_key(contest))=(..., masters) already exists.',
          );
        })(),
      );

      await expect(
        service.update(EVENT, TEMPLATE, {
          contests: ['Male Open', 'Masters'],
        }),
      ).rejects.toThrow(/Masters/);
    });

    it('reports a second default for one event', async () => {
      const { service } = harness(() => {
        throw violation('hyfit_v2_cert_templates_one_default');
      });

      await expect(
        service.create(EVENT, { is_default: true }),
      ).rejects.toThrow(/already has a default/i);
    });

    it('lets an unrecognised database error through unchanged', async () => {
      const { service } = harness(() => {
        throw new Error('connection terminated unexpectedly');
      });

      await expect(
        service.update(EVENT, TEMPLATE, { name: 'Podium' }),
      ).rejects.toThrow('connection terminated unexpectedly');
    });
  });

  describe('importing the artwork', () => {
    const file = (over: Record<string, unknown> = {}) => ({
      buffer: Buffer.from([1, 2, 3]),
      originalname: 'certificate.png',
      mimetype: 'image/png',
      ...over,
    });

    it('writes inside a prefix the assets bucket serves publicly', async () => {
      // Anything outside org_logos/, event_photos/ or organisations/ 403s to
      // the results page — the object would upload and the certificate would
      // then fail to draw, which is the worst of both.
      const { service, uploads } = harness(() => ({ rows: [row()] }));

      await service.uploadBackground(EVENT, TEMPLATE, file() as any);

      expect(uploads[0].prefix.startsWith('event_photos/')).toBe(true);
      expect(uploads[0].prefix).toContain(EVENT);
    });

    it('names the object after the template, so re-importing replaces it', async () => {
      const { service, uploads } = harness(() => ({ rows: [row()] }));

      await service.uploadBackground(EVENT, TEMPLATE, file() as any);

      expect(uploads[0].name).toBe(`template-${TEMPLATE}`);
    });

    it('falls back to the filename when the browser declares nothing', async () => {
      const { service, uploads } = harness(() => ({ rows: [row()] }));

      await service.uploadBackground(
        EVENT,
        TEMPLATE,
        file({ mimetype: 'application/octet-stream' }) as any,
      );

      expect(uploads[0].contentType).toBe('image/png');
    });

    it('refuses a PDF, which the renderer cannot draw as a background', async () => {
      const { service } = harness(() => ({ rows: [row()] }));

      await expect(
        service.uploadBackground(
          EVENT,
          TEMPLATE,
          file({ mimetype: 'application/pdf', originalname: 'cert.pdf' }) as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s before writing anything when the template is not this event’s', async () => {
      const { service, uploads } = harness(() => ({ rows: [] }));

      await expect(
        service.uploadBackground(EVENT, TEMPLATE, file() as any),
      ).rejects.toThrow(NotFoundException);
      expect(uploads).toHaveLength(0);
    });
  });
});
