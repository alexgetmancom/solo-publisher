import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Stable public URLs are hard links to content-addressed blobs. Replacement is
 * by rename, never an in-place write, so a new locale version cannot mutate a
 * sibling URL sharing the same inode. */
export async function deduplicateSiteMediaFile(mediaRoot: string, file: string): Promise<void> {
  const root = path.resolve(mediaRoot);
  const source = path.resolve(file);
  if (!isInside(root, source)) throw new Error("site media file escapes media root");
  if (!(await fs.promises.stat(source)).isFile()) throw new Error("site media file must be a regular file");
  const extension = path.extname(source).toLowerCase();
  if (!extension) throw new Error("site media file requires an extension");
  const blobDirectory = path.join(root, ".blobs");
  const blob = path.join(blobDirectory, `${await sha256File(source)}${extension}`);
  await fs.promises.mkdir(blobDirectory, { recursive: true });
  try {
    await fs.promises.link(source, blob);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const [sourceStat, blobStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(blob)]);
  if (sourceStat.dev === blobStat.dev && sourceStat.ino === blobStat.ino) return;
  const temporary = temporaryPath(source);
  try {
    await fs.promises.link(blob, temporary);
    await fs.promises.rename(temporary, source);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function copyFileAtomically(source: string, target: string): Promise<void> {
  const temporary = temporaryPath(target);
  try {
    await fs.promises.copyFile(source, temporary);
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeResponseAtomically(target: string, response: Response): Promise<void> {
  const temporary = temporaryPath(target);
  try {
    await Bun.write(temporary, response);
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

export function temporaryPath(target: string): string {
  const extension = path.extname(target);
  const stem = extension ? path.basename(target, extension) : path.basename(target);
  return path.join(path.dirname(target), `.${stem}.tmp-${process.pid}-${crypto.randomUUID()}${extension}`);
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function isSiteMediaExtension(file: string): boolean {
  return /\.(avif|gif|jpe?g|mp4|png|webp)$/i.test(file);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
