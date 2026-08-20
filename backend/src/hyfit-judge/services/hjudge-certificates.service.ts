import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { extname } from 'path';
import { HjudgeDbService } from '../hjudge-db.service';
import { S3Service } from '../../common/storage/s3.service';

/**
 * Certificate templates for a HYFIT event.
 *
 * A template is artwork plus a LAYOUT — the `CertConfig` JSON the certificate
 * editor produces, listing where each dynamic value prints and in what font,
 * size and colour — plus its COVERAGE: the set of contests it is for, or the
 * flag marking it the event's fallback. One design covering Male Open, Female
 * Open and Masters is one upload and one layout, not three copies to keep in
 * step.
 *
 * This service stores all of that and answers two audiences with deliberately
 * different reads:
 *
 *   the console   every template, published or not, with its full coverage,
 *                 because designing one is the reason the screen exists.
 *   the public    exactly one, resolved for the contest the athlete raced, and
 *                 only if it is published.
 *
 * WHAT KEEPS RESOLUTION HONEST is in the database, not here: a partial unique
 * index allows one default per event, and a unique index on
 * `(event_id, contest_key(contest))` allows one template per contest. Both
 * reads below take the first row they find and are only correct because of
 * them.
 *
 * NOTHING IS RENDERED HERE. The PDF is drawn in the browser by
 * `utils/schemaCertRenderer.ts`, from this template plus the standings row the
 * results page already holds. That keeps the download off the server entirely
 * — no fonts to install, no per-click work on a public route — and means the
 * preview an admin sees in the editor and the file an athlete receives come
 * out of one piece of code. See `hfg-certificate.service.ts` for the older,
 * server-drawn, hard-coded design this replaces.
 */
@Injectable()
export class HjudgeCertificatesService {
  private readonly logger = new Logger(HjudgeCertificatesService.name);

  constructor(
    private readonly db: HjudgeDbService,
    private readonly s3: S3Service,
  ) {}

  /* ------------------------------------------------------------------ read */

  /* The columns every console read returns, with coverage folded in.
   *
   * `contests` is aggregated rather than joined out into rows because a
   * template covering three contests is ONE template — returning it three
   * times would make the list screen count wrong and the editor's load
   * ambiguous. The FILTER is what leaves a template covering nothing with an
   * empty array instead of `{NULL}`, which every caller would then have to
   * strip.
   */
  private static readonly SELECT_TEMPLATE = `
    SELECT t.id, t.event_id, t.name, t.is_default, t.background_url, t.schema,
           t.is_published, t.created_at, t.updated_at,
           COALESCE(
             array_agg(c.contest ORDER BY c.contest)
               FILTER (WHERE c.contest IS NOT NULL),
             '{}'
           ) AS contests
      FROM hyfit_v2.certificate_templates t
      LEFT JOIN hyfit_v2.certificate_template_contests c ON c.template_id = t.id`;

  /** Every template for the event, the fallback first. Console only. */
  async list(eventId: string) {
    const { rows } = await this.db.q(
      `${HjudgeCertificatesService.SELECT_TEMPLATE}
        WHERE t.event_id = $1
        GROUP BY t.id
        ORDER BY t.is_default DESC, t.name`,
      [eventId],
    );
    return { templates: rows };
  }

  async get(eventId: string, id: string) {
    const row = await this.db.q1(
      `${HjudgeCertificatesService.SELECT_TEMPLATE}
        WHERE t.event_id = $1 AND t.id = $2
        GROUP BY t.id`,
      [eventId, id],
    );
    if (!row) throw new NotFoundException('Certificate template not found');
    return { template: row };
  }

  /**
   * The one template a given finisher's certificate prints on.
   *
   * A design that NAMES their contest beats the event default, and an
   * unpublished one is not a candidate for either — so an event whose only
   * design is a draft answers null, and the results page shows no Download
   * button rather than one that fails.
   *
   * The ORDER BY is what expresses "named beats fallback". Taking the first row
   * is safe only because the two unique indexes make at most one of each
   * possible; without them this would be a coin toss between designs.
   *
   * Returns the artwork and the layout and nothing else. This is read from an
   * unauthenticated route.
   */
  async publicTemplate(eventId: string, contest: string | null | undefined) {
    const row = await this.db.q1(
      `SELECT t.id, t.name, t.is_default, t.background_url, t.schema,
              (cov.template_id IS NOT NULL) AS matched_contest
         FROM hyfit_v2.certificate_templates t
         LEFT JOIN hyfit_v2.certificate_template_contests cov
                ON cov.template_id = t.id
               AND hyfit_v2.contest_key(cov.contest) = hyfit_v2.contest_key($2)
        WHERE t.event_id = $1
          AND t.is_published
          AND (cov.template_id IS NOT NULL OR t.is_default)
        ORDER BY (cov.template_id IS NOT NULL) DESC
        LIMIT 1`,
      [eventId, contest ?? ''],
    );
    return row ?? null;
  }

  /* ----------------------------------------------------------------- write */

  async create(
    eventId: string,
    body: { contests?: unknown; is_default?: boolean; name?: string },
  ): Promise<{ template: Record<string, any> }> {
    const contests = normaliseContests(body?.contests);
    const isDefault = Boolean(body?.is_default);
    const name =
      String(body?.name ?? '').trim() ||
      (contests.length ? `${contests[0]} certificate` : 'Event certificate');

    const id = await this.db
      .tx(async (client) => {
        const inserted = await client.query(
          `INSERT INTO hyfit_v2.certificate_templates (event_id, name, is_default)
           VALUES ($1, $2, $3) RETURNING id`,
          [eventId, name, isDefault],
        );
        const newId: string = inserted.rows[0].id;
        await replaceContests(client, eventId, newId, contests);
        return newId;
      })
      .catch((err) => {
        throw explain(err, contests);
      });

    return this.get(eventId, id);
  }

  /**
   * Save a design.
   *
   * Every field is optional and only what is present is written, because this
   * one route serves four different acts: the editor saving a layout, the list
   * screen renaming a template, the publish toggle, and changing which
   * contests a design covers. A PUT that overwrote the absent columns with
   * defaults would have a rename discard the layout.
   *
   * `contests`, when present, REPLACES the set rather than adding to it —
   * clearing a checkbox in the console has to be able to remove a contest, and
   * an add-only endpoint would leave no way to.
   */
  async update(
    eventId: string,
    id: string,
    body: {
      name?: string;
      contests?: unknown;
      is_default?: boolean;
      schema?: unknown;
      background_url?: string | null;
      is_published?: boolean;
    },
  ) {
    const sets: string[] = [];
    const params: unknown[] = [eventId, id];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      sets.push(`${sql} = $${params.length}`);
    };

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new BadRequestException('A template needs a name');
      push('name', name);
    }
    if (body.is_default !== undefined) {
      push('is_default', Boolean(body.is_default));
    }
    if (body.schema !== undefined) {
      if (body.schema === null || typeof body.schema !== 'object') {
        throw new BadRequestException('schema must be an object');
      }
      push('schema', JSON.stringify(body.schema));
    }
    if (body.background_url !== undefined) {
      push('background_url', body.background_url || null);
    }
    if (body.is_published !== undefined) {
      push('is_published', Boolean(body.is_published));
    }

    const contests =
      body.contests === undefined ? null : normaliseContests(body.contests);

    if (!sets.length && contests === null) return this.get(eventId, id);

    // ONE transaction, because the columns and the coverage are one edit. A
    // template that took its new name but not its new contests — or worse, was
    // published while its coverage insert failed — is a state the console never
    // asked for and cannot see.
    await this.db
      .tx(async (client) => {
        const { rowCount } = sets.length
          ? await client.query(
              `UPDATE hyfit_v2.certificate_templates
                  SET ${sets.join(', ')}
                WHERE event_id = $1 AND id = $2`,
              params,
            )
          : await client.query(
              `SELECT 1 FROM hyfit_v2.certificate_templates
                WHERE event_id = $1 AND id = $2`,
              [eventId, id],
            );
        if (!rowCount) {
          throw new NotFoundException('Certificate template not found');
        }

        if (contests !== null) {
          await replaceContests(client, eventId, id, contests);
        }
      })
      .catch((err) => {
        if (err instanceof NotFoundException) throw err;
        throw explain(err, contests ?? []);
      });

    return this.get(eventId, id);
  }

  async remove(eventId: string, id: string) {
    const { rowCount } = await this.db.q(
      `DELETE FROM hyfit_v2.certificate_templates
        WHERE event_id = $1 AND id = $2`,
      [eventId, id],
    );
    if (!rowCount) throw new NotFoundException('Certificate template not found');
    // The coverage rows go with it — the child table cascades. The artwork is
    // deliberately left in S3: an object deleted here is unrecoverable, and a
    // template is routinely deleted to be rebuilt from the same file.
    return { deleted: true };
  }

  /**
   * Store the uploaded artwork and point the template at it.
   *
   * THE PREFIX IS LOAD-BEARING. The assets bucket serves three public prefixes
   * and nothing else; an object written outside them answers 403 to the very
   * page that has to draw it. `event_photos/` is one of them.
   */
  async uploadBackground(
    eventId: string,
    id: string,
    file: { buffer: Buffer; originalname: string; mimetype?: string } | undefined,
  ): Promise<{ url: string }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file uploaded');
    }
    await this.get(eventId, id); // 404s before anything is written

    const mimeType = normaliseImageType(file);
    const extension = extname(file.originalname || '') || extensionFor(mimeType);

    const url = await this.s3.uploadFile(
      file.buffer,
      mimeType,
      `event_photos/hyfit/${eventId}/certificates`,
      extension,
      // Named by template, so re-importing artwork replaces the object rather
      // than leaving the old one orphaned behind a changed URL.
      `template-${id}`,
    );

    await this.db.q(
      `UPDATE hyfit_v2.certificate_templates
          SET background_url = $3
        WHERE event_id = $1 AND id = $2`,
      [eventId, id, url],
    );

    this.logger.log(`certificate template ${id}: background stored at ${url}`);
    return { url };
  }
}

/* ---------------------------------------------------------------- coverage */

type Client = { query: (sql: string, params?: unknown[]) => Promise<any> };

/**
 * The coverage rows for one template, made to equal `contests`.
 *
 * Delete-then-insert rather than a diff: the set is a handful of rows inside a
 * transaction, and a diff would be more code defending the same invariant the
 * unique index already defends.
 */
async function replaceContests(
  client: Client,
  eventId: string,
  templateId: string,
  contests: string[],
) {
  await client.query(
    'DELETE FROM hyfit_v2.certificate_template_contests WHERE template_id = $1',
    [templateId],
  );
  if (!contests.length) return;
  await client.query(
    `INSERT INTO hyfit_v2.certificate_template_contests (template_id, event_id, contest)
     SELECT $1, $2, contest FROM unnest($3::text[]) AS contest`,
    [templateId, eventId, contests],
  );
}

/**
 * The contests a caller sent, as a clean list.
 *
 * Blanks are dropped rather than stored: an empty contest would be a coverage
 * row matching a finisher whose contest the feed left empty, which is what
 * `is_default` is for. Duplicates are collapsed BY KEY, because "Male Open" and
 * "MALE  OPEN" arriving in one request are one contest and would otherwise hit
 * the unique index and read to the operator as a clash with another template.
 */
function normaliseContests(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('contests must be a list of contest names');
  }
  const seen = new Map<string, string>();
  for (const entry of value) {
    const name = String(entry ?? '').trim();
    if (!name) continue;
    const key = contestKey(name);
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

/** `hyfit_v2.contest_key` in TypeScript. Must agree with the SQL function. */
function contestKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A constraint violation, turned into something an operator can act on.
 *
 * Each of these is a user mistake rather than a server fault, and the
 * constraint name is the only thing that distinguishes them. The contest clash
 * in particular has to say WHICH contest, because the console offers a dozen
 * checkboxes and "already covered" names none of them.
 */
function explain(err: any, contests: string[]): Error {
  if (err?.constraint === 'hyfit_v2_cert_templates_publishable') {
    return new BadRequestException(
      'Import a background and place at least one field before publishing',
    );
  }
  if (err?.constraint === 'hyfit_v2_cert_templates_one_default') {
    return new BadRequestException(
      'This event already has a default template. Turn that one off first, or cover specific contests instead.',
    );
  }
  if (err?.constraint === 'hyfit_v2_cert_contests_event_contest') {
    // Postgres reports the clashing VALUES in `detail`, and the index is on the
    // normalised key — so the raw name the operator typed is matched back
    // through the same normalisation rather than searched for literally.
    const detail = String(err?.detail ?? '');
    const named = contests.find((c) => detail.includes(contestKey(c)));
    return new BadRequestException(
      named
        ? `Another template already covers “${named}”`
        : 'Another template already covers one of those contests',
    );
  }
  return err;
}

/* ------------------------------------------------------------------ upload */

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The browser's declared type, or the filename's when the browser declined to
 * guess. A PDF template is refused rather than accepted and rendered blank:
 * the renderer draws the background with `addImage`, which takes a bitmap.
 */
function normaliseImageType(file: {
  originalname: string;
  mimetype?: string;
}): string {
  let type = (file.mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/jpg') type = 'image/jpeg';

  if (!type || type === 'application/octet-stream') {
    const ext = extname(file.originalname || '').toLowerCase();
    if (ext === '.png') type = 'image/png';
    else if (ext === '.webp') type = 'image/webp';
    else if (ext === '.jpg' || ext === '.jpeg') type = 'image/jpeg';
  }

  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    throw new BadRequestException(
      'The background must be a JPEG, PNG or WEBP image',
    );
  }
  return type;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}
