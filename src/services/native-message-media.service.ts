import { createHash } from "crypto";
import type { LlmAudioPart, LlmImagePart } from "../llm/types";
import type { AssemblyMediaSegmentV1 as NativeMediaPartProjectionV1 } from "../types/agent-preprocessing";
import type { Image } from "../types/image";
import type { Message } from "../types/message";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_NATIVE_MESSAGE_MEDIA_PARTS,
  MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../types/media-limits";
import {
  isSupportedProxyImageContentType,
  normalizeImageContentType,
  validateImageMagicBytes,
} from "../utils/image-signature";
import * as audioSvc from "./audio.service";
import * as chatsSvc from "./chats.service";
import * as imagesSvc from "./images.service";
import { detectAudioFormat } from "./notification-sounds.service";

export type NativeMediaTypeV1 = "image" | "audio";
export type NativeMaterializedMediaPart = LlmImagePart | LlmAudioPart;

export class NativeMediaProjectionError extends Error {
  readonly code: "invalid_input" | "limit_exceeded";

  constructor(code: "invalid_input" | "limit_exceeded", message: string) {
    super(message);
    this.name = "NativeMediaProjectionError";
    this.code = code;
  }
}

interface AudioAuthorityRow {
  readonly id: string;
  readonly mime_type: string;
  readonly size_bytes: number;
}

export interface NativeMediaAuthority {
  readonly getMessage: (userId: string, messageId: string) => Message | null;
  readonly getImage: (userId: string, mediaId: string) => Image | null;
  readonly getImageFilePath: (userId: string, mediaId: string) => Promise<string | null>;
  readonly getAudio: (userId: string, mediaId: string) => AudioAuthorityRow | null;
  readonly getAudioFilePath: (userId: string, mediaId: string) => string | null;
  readonly readFile: (path: string) => Promise<Buffer>;
}

export interface NativeMediaProjectionResultV1 {
  readonly byMessageId: Readonly<Record<string, readonly NativeMediaPartProjectionV1[]>>;
  readonly materialize: (projection: NativeMediaPartProjectionV1) => NativeMaterializedMediaPart;
}

const DEFAULT_AUTHORITY: NativeMediaAuthority = {
  getMessage: chatsSvc.getMessage,
  getImage: imagesSvc.getImage,
  getImageFilePath: (userId, mediaId) => imagesSvc.getImageFilePath(userId, mediaId),
  getAudio: audioSvc.getAudio,
  getAudioFilePath: audioSvc.getAudioFilePath,
  readFile: async (path) => Buffer.from(await Bun.file(path).arrayBuffer()),
};

function normalizedMime(value: unknown): string {
  return typeof value === "string"
    ? value.split(";", 1)[0]!.trim().toLowerCase()
    : "";
}

function projectionKey(projection: NativeMediaPartProjectionV1): string {
  return [
    projection.mediaType,
    projection.mediaId,
    projection.mimeType,
    String(projection.byteLength),
    projection.sha256,
  ].join("\u0000");
}

async function readAuthoritativeBytes(
  path: string | null,
  label: string,
  readFile: NativeMediaAuthority["readFile"],
): Promise<Buffer> {
  if (!path) throw new NativeMediaProjectionError("invalid_input", `${label} file is unavailable`);
  try {
    return await readFile(path);
  } catch {
    throw new NativeMediaProjectionError("invalid_input", `${label} file is unreadable`);
  }
}

async function resolveImage(
  userId: string,
  mediaId: string,
  claimedMime: string,
  authority: NativeMediaAuthority,
  remainingBytes: number,
): Promise<{ projection: NativeMediaPartProjectionV1; part: LlmImagePart }> {
  const image = authority.getImage(userId, mediaId);
  if (authority.getAudio(userId, mediaId)) {
    throw new NativeMediaProjectionError("invalid_input", "Attachment kind does not match authoritative storage");
  }
  if (!image) {
    throw new NativeMediaProjectionError("invalid_input", "Image attachment is unavailable");
  }
  const mimeType = normalizeImageContentType(image.mime_type);
  if (!isSupportedProxyImageContentType(mimeType) || claimedMime !== mimeType) {
    throw new NativeMediaProjectionError("invalid_input", "Image attachment MIME is not authoritative");
  }
  if (!Number.isSafeInteger(image.byte_size) || image.byte_size <= 0) {
    throw new NativeMediaProjectionError("invalid_input", "Image attachment size metadata is malformed");
  }
  if (image.byte_size > MAX_IMAGE_BYTES || image.byte_size > remainingBytes) {
    throw new NativeMediaProjectionError("limit_exceeded", "Image attachment exceeds the native media limit");
  }
  const path = await authority.getImageFilePath(userId, mediaId);
  const bytes = await readAuthoritativeBytes(path, "Image attachment", authority.readFile);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES || bytes.byteLength > remainingBytes) {
    throw new NativeMediaProjectionError("limit_exceeded", "Image attachment exceeds the native media limit");
  }
  if (image.byte_size !== bytes.byteLength || !validateImageMagicBytes(bytes, mimeType)) {
    throw new NativeMediaProjectionError("invalid_input", "Image attachment bytes do not match authoritative metadata");
  }
  const projection: NativeMediaPartProjectionV1 = Object.freeze({
    kind: "media",
    mediaType: "image",
    mediaId,
    mimeType,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { projection, part: Object.freeze({ type: "image", data: bytes.toString("base64"), mime_type: mimeType }) };
}

async function resolveAudio(
  userId: string,
  mediaId: string,
  claimedMime: string,
  authority: NativeMediaAuthority,
  remainingBytes: number,
): Promise<{ projection: NativeMediaPartProjectionV1; part: LlmAudioPart }> {
  const audio = authority.getAudio(userId, mediaId);
  if (authority.getImage(userId, mediaId)) {
    throw new NativeMediaProjectionError("invalid_input", "Attachment kind does not match authoritative storage");
  }
  if (!audio) {
    throw new NativeMediaProjectionError("invalid_input", "Audio attachment is unavailable");
  }
  const mimeType = normalizedMime(audio.mime_type);
  if (!mimeType.startsWith("audio/") || claimedMime !== mimeType) {
    throw new NativeMediaProjectionError("invalid_input", "Audio attachment MIME is not authoritative");
  }
  if (!Number.isSafeInteger(audio.size_bytes) || audio.size_bytes <= 0) {
    throw new NativeMediaProjectionError("invalid_input", "Audio attachment size metadata is malformed");
  }
  if (audio.size_bytes > MAX_AUDIO_BYTES || audio.size_bytes > remainingBytes) {
    throw new NativeMediaProjectionError("limit_exceeded", "Audio attachment exceeds the native media limit");
  }
  const bytes = await readAuthoritativeBytes(
    authority.getAudioFilePath(userId, mediaId),
    "Audio attachment",
    authority.readFile,
  );
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES || bytes.byteLength > remainingBytes) {
    throw new NativeMediaProjectionError("limit_exceeded", "Audio attachment exceeds the native media limit");
  }
  const detected = detectAudioFormat(bytes);
  if (audio.size_bytes !== bytes.byteLength || !detected || detected.mimeType !== mimeType) {
    throw new NativeMediaProjectionError("invalid_input", "Audio attachment bytes do not match authoritative metadata");
  }
  const projection: NativeMediaPartProjectionV1 = Object.freeze({
    kind: "media",
    mediaType: "audio",
    mediaId,
    mimeType,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { projection, part: Object.freeze({ type: "audio", data: bytes.toString("base64"), mime_type: mimeType }) };
}

/** Resolve, authenticate, inspect, and seal only the admitted current user turn. */
export async function resolveNativeCurrentTurnMedia(
  userId: string,
  chatId: string,
  sourceUserMessageIds: readonly string[],
  authority: NativeMediaAuthority = DEFAULT_AUTHORITY,
): Promise<NativeMediaProjectionResultV1> {
  const byMessageId: Record<string, readonly NativeMediaPartProjectionV1[]> = {};
  const materialized = new Map<string, NativeMaterializedMediaPart>();
  const seenMessages = new Set<string>();
  let partCount = 0;
  let totalBytes = 0;

  for (const messageId of sourceUserMessageIds) {
    if (typeof messageId !== "string" || messageId.length === 0 || seenMessages.has(messageId)) {
      throw new NativeMediaProjectionError("invalid_input", "Current-turn message identity is malformed");
    }
    seenMessages.add(messageId);
    const message = authority.getMessage(userId, messageId);
    if (!message || message.chat_id !== chatId || !message.is_user || message.extra?.hidden === true || message.extra?.hidden === 1) {
      throw new NativeMediaProjectionError("invalid_input", "Current-turn message is unavailable");
    }
    const rawAttachments = message.extra?.attachments;
    if (rawAttachments === undefined || rawAttachments === null) continue;
    if (!Array.isArray(rawAttachments)) {
      throw new NativeMediaProjectionError("invalid_input", "Current-turn attachments are malformed");
    }
    const projections: NativeMediaPartProjectionV1[] = [];
    for (const raw of rawAttachments) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new NativeMediaProjectionError("invalid_input", "Current-turn attachment is malformed");
      }
      const attachment = raw as Record<string, unknown>;
      if (attachment.swipe_id !== undefined && attachment.swipe_id !== message.swipe_id) continue;
      const mediaType = attachment.type;
      const mediaId = attachment.image_id;
      const claimedMime = normalizedMime(attachment.mime_type);
      if (
        (mediaType !== "image" && mediaType !== "audio")
        || typeof mediaId !== "string"
        || mediaId.length === 0
        || claimedMime.length === 0
      ) {
        throw new NativeMediaProjectionError("invalid_input", "Current-turn attachment is unsupported or malformed");
      }
      partCount += 1;
      if (partCount > MAX_NATIVE_MESSAGE_MEDIA_PARTS) {
        throw new NativeMediaProjectionError("limit_exceeded", "Current-turn attachment count exceeds the native media limit");
      }
      const remainingBytes = MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES - totalBytes;
      const resolved = mediaType === "image"
        ? await resolveImage(userId, mediaId, claimedMime, authority, remainingBytes)
        : await resolveAudio(userId, mediaId, claimedMime, authority, remainingBytes);
      totalBytes += resolved.projection.byteLength;
      projections.push(resolved.projection);
      materialized.set(projectionKey(resolved.projection), resolved.part);
    }
    if (projections.length > 0) byMessageId[messageId] = Object.freeze(projections);
  }

  return Object.freeze({
    byMessageId: Object.freeze(byMessageId),
    materialize: (projection: NativeMediaPartProjectionV1) => {
      const part = materialized.get(projectionKey(projection));
      if (!part) throw new NativeMediaProjectionError("invalid_input", "Sealed media projection is unavailable");
      return part;
    },
  });
}
