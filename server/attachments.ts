import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { makeId } from "./utils.js";

type HttpError = Error & { status: number };

function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

export const IMAGE_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_INPUT = 6;

export const GENERAL_FILE_EXTENSIONS: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "text/typescript": ".ts",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/xml": ".xml",
  "application/yaml": ".yaml",
};
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type ImageAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  fileName: string;
  path: string;
  url: string;
  thumbnailDataUrl: string;
};

function safeOriginalName(name: unknown, fallback: string) {
  const safe = basename(String(name || fallback)).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return safe.slice(0, 96) || fallback;
}

export function parseImageDataUrl(dataUrl: unknown) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) throw httpError(400, "Attachment must be an image data URL");
  const [, type, encoded] = match;
  const extension = IMAGE_TYPES.get(type!);
  if (!extension) throw httpError(400, `Unsupported image type: ${type}`);
  const buffer = Buffer.from(encoded!.replace(/\s/g, ""), "base64");
  if (!buffer.length) throw httpError(400, "Attachment image is empty");
  if (buffer.length > MAX_IMAGE_BYTES) throw httpError(400, "Attachment image exceeds 8 MB");
  return { type: type!, extension, buffer };
}

export function parseFileDataUrl(dataUrl: unknown) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) throw httpError(400, "Attachment must be a base64 data URL");
  const [, type, encoded] = match;
  const extension = IMAGE_TYPES.get(type!) || GENERAL_FILE_EXTENSIONS[type!] || ".bin";
  const buffer = Buffer.from(encoded!.replace(/\s/g, ""), "base64");
  if (!buffer.length) throw httpError(400, "Attachment is empty");
  if (buffer.length > MAX_FILE_BYTES) throw httpError(400, "Attachment exceeds 20 MB");
  return { type: type!, extension, buffer };
}

export function attachmentMissingSvg(fileName: string) {
  const safeName = String(fileName || "image").replace(/[<>&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220" role="img" aria-label="Image unavailable">
    <rect width="320" height="220" rx="18" fill="#eef3f3"/>
    <path d="M92 142l38-44 30 34 20-22 48 56H92z" fill="#b9cdce"/>
    <circle cx="211" cy="74" r="18" fill="#cfdcdd"/>
    <text x="160" y="190" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#66787c">${safeName} unavailable</text>
  </svg>`;
}

export async function saveAttachments(input: unknown, attachmentRoot: string): Promise<ImageAttachment[]> {
  const attachments = Array.isArray(input) ? input : [];
  if (attachments.length > MAX_IMAGES_PER_INPUT) {
    throw httpError(400, `Attach at most ${MAX_IMAGES_PER_INPUT} files per message`);
  }
  if (!attachments.length) return [];

  await mkdir(attachmentRoot, { recursive: true });
  const saved: ImageAttachment[] = [];
  for (const attachment of attachments) {
    const isImage = String(attachment.dataUrl || "").startsWith("data:image/");
    const { type, extension, buffer } = isImage
      ? parseImageDataUrl(attachment.dataUrl)
      : parseFileDataUrl(attachment.dataUrl);
    const id = makeId(isImage ? "img" : "file");
    const fileName = `${id}${extension}`;
    const path = join(attachmentRoot, fileName);
    await writeFile(path, buffer);
    saved.push({
      id,
      name: safeOriginalName(attachment.name, fileName),
      type,
      size: buffer.length,
      fileName,
      path,
      url: `/api/attachments/${fileName}`,
      thumbnailDataUrl: isImage ? (attachment.dataUrl as string) : ""
    });
  }
  return saved;
}

export const saveImageAttachments = saveAttachments;

export function publicAttachmentPayload(attachments: ImageAttachment[]) {
  return attachments.map(({ id, name, type, size, fileName, path, url, thumbnailDataUrl }) => ({ id, name, type, size, fileName, path, url, thumbnailDataUrl }));
}
