import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { AppConfig } from '../config.js';

/** Provider-agnostic object storage (D-05). The app never deletes backups (DL-010). */
export interface StoragePort {
  readonly description: string;
  put(key: string, body: Readable, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
}

export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  readonly description: string;

  constructor(private readonly bucket: string, opts: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string }) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
    this.description = `s3://${bucket}${opts.endpoint ? ` (${new URL(opts.endpoint).host})` : ''}`;
  }

  async put(key: string, body: Readable, contentType: string): Promise<void> {
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
      queueSize: 2,
      partSize: 16 * 1024 * 1024,
    }).done();
  }

  async get(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return out.Body as Readable;
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const items: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) items.push({ key: o.Key!, size: o.Size ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return items;
  }
}

/** Development/test only (refused by config outside development/test). */
export class LocalDirStorage implements StoragePort {
  readonly description: string;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.description = `local:${this.root}`;
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid key');
    return p;
  }

  async put(key: string, body: Readable): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await pipeline(body, createWriteStream(p));
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.path(key));
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = full.slice(this.root.length + 1).split(sep).join('/');
          if (key.startsWith(prefix)) out.push({ key, size: (await stat(full)).size });
        }
      }
    };
    await walk(this.root);
    return out;
  }
}

export function storageFromConfig(cfg: AppConfig): StoragePort | null {
  if (cfg.BACKUP_LOCAL_DIR) return new LocalDirStorage(cfg.BACKUP_LOCAL_DIR);
  if (cfg.BACKUP_S3_BUCKET && cfg.BACKUP_S3_ACCESS_KEY_ID && cfg.BACKUP_S3_SECRET_ACCESS_KEY) {
    return new S3Storage(cfg.BACKUP_S3_BUCKET, {
      ...(cfg.BACKUP_S3_ENDPOINT ? { endpoint: cfg.BACKUP_S3_ENDPOINT } : {}),
      region: cfg.BACKUP_S3_REGION ?? 'eu-central-003',
      accessKeyId: cfg.BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.BACKUP_S3_SECRET_ACCESS_KEY,
    });
  }
  return null;
}

/** Document storage (Railway bucket in deployed environments, a local folder in development). */
export function filesStorageFromConfig(cfg: AppConfig): StoragePort | null {
  if (cfg.FILES_LOCAL_DIR) return new LocalDirStorage(cfg.FILES_LOCAL_DIR);
  if (cfg.FILES_S3_BUCKET && cfg.FILES_S3_ACCESS_KEY_ID && cfg.FILES_S3_SECRET_ACCESS_KEY) {
    return new S3Storage(cfg.FILES_S3_BUCKET, {
      ...(cfg.FILES_S3_ENDPOINT ? { endpoint: cfg.FILES_S3_ENDPOINT } : {}),
      region: cfg.FILES_S3_REGION ?? 'auto',
      accessKeyId: cfg.FILES_S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.FILES_S3_SECRET_ACCESS_KEY,
    });
  }
  return null;
}
