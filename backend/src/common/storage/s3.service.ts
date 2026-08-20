import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Object storage for a machine with no object store.
 *
 * WHY THIS EXISTS UNDER THE SAME NAME AS PROD'S S3Service. The two deployments
 * run the same modules against the same schema — that is the property that
 * makes a laptop at a venue a usable stand-in for prod — and the certificate
 * service takes a dependency called `S3Service` with three methods on it. The
 * options were to give the local build a different service and fork every
 * caller, or to give it the same interface backed by the only durable store a
 * venue laptop has, which is its own disk. This is the second.
 *
 * IT IS NOT A STUB. A file written here survives a restart, is served back over
 * HTTP by this same server, and is what a certificate at the venue actually
 * prints from. What it does NOT do is make that file reachable from anywhere
 * else — which is correct, because nothing else is supposed to reach a venue
 * laptop.
 *
 * WHERE THE URL POINTS, AND WHY THAT MATTERS. `uploadFile` returns an ABSOLUTE
 * url built from `HYFIT_LOCAL_PUBLIC_URL` — the address the tablets on this
 * network reach this server on. It has to be absolute because the value is
 * stored in `certificate_templates.background_url` and read back by a browser
 * that may be rendering a page served from somewhere else; a relative path
 * would resolve against whatever host the reader happens to be on. When the
 * variable is unset it falls back to a root-relative path, which is right for
 * the common case (the console and the API are the same origin) and visibly
 * wrong for the case that needs the variable set.
 *
 * BACKGROUNDS PULLED FROM PROD ARE NOT COPIED HERE. `background_url` on a
 * template that came down in a configuration pull is prod's own absolute URL
 * into its asset bucket, and it is left exactly as it is: the artwork is
 * prod's, it is public, and a venue with any route out resolves it directly.
 * A venue with NO route out cannot fetch it, and the honest answer to that is
 * that the artwork was never on the laptop — not a copy of it made at pull
 * time, which would double the size of every pull for an image almost nobody
 * prints from at the venue. See `applyConfig` in HjudgePushService.
 */

/** Where uploads live. Under the working directory by default, so a laptop that
 *  was set up by unzipping a folder has a working store with nothing set. */
const ROOT = resolve(
  process.env.HYFIT_LOCAL_UPLOAD_DIR || join(process.cwd(), 'uploads'),
);

/** The path uploads are served back on. Kept as a constant because the static
 *  handler in `server.ts` and the URLs written into the database have to agree,
 *  and they are in two different files. */
export const HYFIT_LOCAL_UPLOAD_ROUTE = '/uploads';

export const hyfitLocalUploadRoot = ROOT;

@Injectable()
export class S3Service {
  private readonly publicBase: string;

  constructor() {
    this.publicBase = String(process.env.HYFIT_LOCAL_PUBLIC_URL ?? '')
      .trim()
      .replace(/\/+$/, '');
  }

  /**
   * Write one file and return the URL it can be read back on.
   *
   * The signature is prod's, argument for argument, including the arguments
   * this implementation has no use for — `contentType` is carried by the
   * extension here and the static handler infers it. Matching the shape is the
   * whole point: a caller must not have to know which deployment it is on.
   */
  async uploadFile(
    buffer: Buffer,
    _contentType: string,
    keyPrefix: string,
    extension: string,
    customFileName?: string,
  ): Promise<string> {
    const cleanCustomName = customFileName
      ? customFileName
          .replace(/\.[^/.]+$/, '')
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .trim()
      : '';

    const fileName = cleanCustomName || randomUUID();
    const key = `${this.safeSegment(keyPrefix)}/${fileName}${extension}`;
    const target = join(ROOT, key);

    // Refused rather than written. `keyPrefix` reaches here from a route
    // parameter, and `../` in it would put a file anywhere on the laptop's
    // disk that this process can write to.
    if (!target.startsWith(ROOT)) {
      throw new InternalServerErrorException(
        'That upload path escapes the upload directory and was refused',
      );
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buffer);
    } catch (error: any) {
      // Names the directory AND what went wrong, because the operator reading
      // this is looking at an upload button that did nothing.
      throw new InternalServerErrorException(
        `Could not write the upload to ${ROOT}: ${error?.message ?? error}`,
      );
    }

    return `${this.publicBase}${HYFIT_LOCAL_UPLOAD_ROUTE}/${key}`;
  }

  /** The key back out of a URL this service produced. */
  keyFromUrl(url: string): string {
    const marker = `${HYFIT_LOCAL_UPLOAD_ROUTE}/`;
    const at = String(url ?? '').indexOf(marker);
    if (at === -1) {
      throw new InternalServerErrorException(
        'That URL was not produced by this server, so it has no local key',
      );
    }
    return String(url).slice(at + marker.length);
  }

  /**
   * Prod's presigned-read equivalent.
   *
   * There is nothing to sign: a file on this disk is served by this server to
   * this network, and there is no third party to hand a time-limited grant to.
   * So it returns the same URL `uploadFile` did, after confirming the file is
   * actually there — because "the link works but 404s" is the failure this
   * method exists to rule out.
   */
  async getPresignedReadUrl(key: string, _forceDownload = false) {
    const target = join(ROOT, key);
    if (!target.startsWith(ROOT)) {
      throw new InternalServerErrorException('That key escapes the upload directory');
    }
    try {
      await readFile(target);
    } catch {
      throw new InternalServerErrorException(
        `${key} is not in this server's upload directory`,
      );
    }
    return `${this.publicBase}${HYFIT_LOCAL_UPLOAD_ROUTE}/${key}`;
  }

  private safeSegment(input: string): string {
    return String(input ?? '')
      .split('/')
      .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_'))
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
  }
}
