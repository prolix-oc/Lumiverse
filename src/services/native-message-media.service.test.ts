import { describe, expect, test } from "bun:test";

import type { Image } from "../types/image";
import type { Message, MessageAttachment } from "../types/message";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_NATIVE_MESSAGE_MEDIA_PARTS,
  MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../types/media-limits";
import {
  NativeMediaProjectionError,
  resolveNativeCurrentTurnMedia,
  type NativeMediaAuthority,
} from "./native-message-media.service";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);

function fixtureMessage(attachments: unknown, overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    chat_id: "chat-1",
    index_in_chat: 1,
    is_user: true,
    name: "User",
    content: "Look at this",
    send_date: 1,
    swipe_id: 2,
    swipes: ["Look at this"],
    swipe_dates: [1],
    extra: { attachments },
    parent_message_id: null,
    branch_id: null,
    created_at: 1,
    ...overrides,
  };
}

function imageRow(id: string, mimeType: string, byteSize: number): Image {
  return {
    id,
    filename: `${id}.bin`,
    original_filename: `${id}.bin`,
    mime_type: mimeType,
    byte_size: byteSize,
    width: null,
    height: null,
    has_thumbnail: false,
    skip_thumbnail_processing: false,
    url: `/images/${id}`,
    specificity: "full",
    owner_extension_identifier: null,
    owner_character_id: null,
    owner_chat_id: "chat-1",
    created_at: 1,
  };
}

interface AuthorityFixture {
  readonly message?: Message | null;
  readonly images?: Readonly<Record<string, Image>>;
  readonly audios?: Readonly<Record<string, { id: string; mime_type: string; size_bytes: number }>>;
  readonly files?: Readonly<Record<string, Buffer>>;
  readonly unreadable?: boolean;
  readonly onRead?: (path: string) => void;
}

function authority(fixture: AuthorityFixture): NativeMediaAuthority {
  return {
    getMessage: (userId, messageId) => userId === "user-1" && messageId === "message-1" ? fixture.message ?? null : null,
    getImage: (userId, mediaId) => userId === "user-1" ? fixture.images?.[mediaId] ?? null : null,
    getImageFilePath: async (userId, mediaId) => userId === "user-1" && fixture.files?.[mediaId] ? mediaId : null,
    getAudio: (userId, mediaId) => userId === "user-1" ? fixture.audios?.[mediaId] ?? null : null,
    getAudioFilePath: (userId, mediaId) => userId === "user-1" && fixture.files?.[mediaId] ? mediaId : null,
    readFile: async (path) => {
      fixture.onRead?.(path);
      if (fixture.unreadable) throw new Error("unreadable");
      const value = fixture.files?.[path];
      if (!value) throw new Error("missing");
      return value;
    },
  };
}

function attachment(type: "image" | "audio", id: string, mimeType: string, swipeId?: number): MessageAttachment {
  return {
    type,
    image_id: id,
    mime_type: mimeType,
    original_filename: `${id}.bin`,
    ...(swipeId === undefined ? {} : { swipe_id: swipeId }),
  };
}

async function expectProjectionError(promise: Promise<unknown>, code: NativeMediaProjectionError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error("expected native media projection to fail");
  } catch (error) {
    if (!(error instanceof NativeMediaProjectionError)) throw error;
    expect(error.code).toBe(code);
  }
}
function paddedMedia(signature: Buffer, byteLength: number): Buffer {
  const value = Buffer.alloc(byteLength);
  signature.copy(value);
  return value;
}

describe("native current-turn media projection", () => {
  test("authenticates image and audio rows, ignores inactive swipes, and seals typed parts", async () => {
    const message = fixtureMessage([
      attachment("image", "image-1", "image/png"),
      attachment("audio", "audio-1", "audio/wav", 2),
      attachment("audio", "inactive-audio", "audio/wav", 1),
    ]);
    const result = await resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message,
      images: { "image-1": imageRow("image-1", "image/png", PNG.byteLength) },
      audios: {
        "audio-1": { id: "audio-1", mime_type: "audio/wav", size_bytes: WAV.byteLength },
        "inactive-audio": { id: "inactive-audio", mime_type: "audio/wav", size_bytes: WAV.byteLength },
      },
      files: { "image-1": PNG, "audio-1": WAV, "inactive-audio": WAV },
    }));

    const projections = result.byMessageId["message-1"]!;
    expect(projections.map((item) => item.mediaType)).toEqual(["image", "audio"]);
    expect(projections.every((item) => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true);
    expect(result.materialize(projections[0]!)).toEqual({ type: "image", data: PNG.toString("base64"), mime_type: "image/png" });
    expect(result.materialize(projections[1]!)).toEqual({ type: "audio", data: WAV.toString("base64"), mime_type: "audio/wav" });
  });

  test("rejects malformed, foreign-chat, hidden, and non-user current-turn messages", async () => {
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage("not-an-array"),
    })), "invalid_input");
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([], { chat_id: "chat-2" }),
    })), "invalid_input");
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([], { extra: { hidden: 1 } }),
    })), "invalid_input");
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([], { is_user: false }),
    })), "invalid_input");
  });

  test("rejects MIME spoofing, wrong storage tables, signature mismatch, and unreadable files", async () => {
    const spoofed = fixtureMessage([attachment("image", "image-1", "image/jpeg")]);
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: spoofed,
      images: { "image-1": imageRow("image-1", "image/png", PNG.byteLength) },
      files: { "image-1": PNG },
    })), "invalid_input");

    const wrongTable = fixtureMessage([attachment("image", "audio-1", "image/png")]);
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: wrongTable,
      audios: { "audio-1": { id: "audio-1", mime_type: "audio/wav", size_bytes: WAV.byteLength } },
      files: { "audio-1": WAV },
    })), "invalid_input");

    const badMagic = fixtureMessage([attachment("image", "image-1", "image/png")]);
    const junk = Buffer.from("not a png");
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: badMagic,
      images: { "image-1": imageRow("image-1", "image/png", junk.byteLength) },
      files: { "image-1": junk },
    })), "invalid_input");
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: badMagic,
      images: { "image-1": imageRow("image-1", "image/png", PNG.byteLength) },
      files: { "image-1": PNG },
      unreadable: true,
    })), "invalid_input");
  });

  test("rejects authoritative media beyond the native byte cap before hashing", async () => {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
    oversized.set(PNG, 0);
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([attachment("image", "image-1", "image/png")]),
      images: { "image-1": imageRow("image-1", "image/png", oversized.byteLength) },
      files: { "image-1": oversized },
    })), "limit_exceeded");
  });

  test("accepts exactly the native part-count cap and rejects the next active part", async () => {
    const ids = Array.from({ length: MAX_NATIVE_MESSAGE_MEDIA_PARTS + 1 }, (_, index) => `image-${index + 1}`);
    const attachments = ids.map((id) => attachment("image", id, "image/png"));
    const images = Object.fromEntries(ids.map((id) => [id, imageRow(id, "image/png", PNG.byteLength)]));
    const files = Object.fromEntries(ids.map((id) => [id, PNG]));
    const exact = await resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage(attachments.slice(0, MAX_NATIVE_MESSAGE_MEDIA_PARTS)),
      images,
      files,
    }));
    expect(exact.byMessageId["message-1"]).toHaveLength(MAX_NATIVE_MESSAGE_MEDIA_PARTS);

    let reads = 0;
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage(attachments),
      images,
      files,
      onRead: () => { reads += 1; },
    })), "limit_exceeded");
    expect(reads).toBe(MAX_NATIVE_MESSAGE_MEDIA_PARTS);
  });

  test("accepts exact image-audio cumulative bytes and rejects one byte over before reading it", async () => {
    const imageBytes = paddedMedia(PNG, MAX_IMAGE_BYTES);
    const audioBytes = paddedMedia(WAV, MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES - MAX_IMAGE_BYTES);
    const exact = await resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([
        attachment("image", "image-boundary", "image/png"),
        attachment("audio", "audio-remainder", "audio/wav"),
      ]),
      images: { "image-boundary": imageRow("image-boundary", "image/png", imageBytes.byteLength) },
      audios: { "audio-remainder": { id: "audio-remainder", mime_type: "audio/wav", size_bytes: audioBytes.byteLength } },
      files: { "image-boundary": imageBytes, "audio-remainder": audioBytes },
    }));
    const exactParts = exact.byMessageId["message-1"] ?? [];
    expect(exactParts.reduce((sum, part) => sum + part.byteLength, 0)).toBe(MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES);
    expect(exactParts.map((part) => exact.materialize(part).type)).toEqual(["image", "audio"]);

    let imageReads = 0;
    const audioRemainderOver = audioBytes.byteLength + 1;
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([
        attachment("audio", "audio-remainder", "audio/wav"),
        attachment("image", "image-over-total", "image/png"),
      ]),
      images: { "image-over-total": imageRow("image-over-total", "image/png", MAX_IMAGE_BYTES) },
      audios: { "audio-remainder": { id: "audio-remainder", mime_type: "audio/wav", size_bytes: audioRemainderOver } },
      files: { "audio-remainder": paddedMedia(WAV, audioRemainderOver), "image-over-total": PNG },
      onRead: (path) => { if (path === "image-over-total") imageReads += 1; },
    })), "limit_exceeded");
    expect(imageReads).toBe(0);
  });

  test("accepts the exact audio item cap and rejects one byte over before reading", async () => {
    const audioBoundary = paddedMedia(WAV, MAX_AUDIO_BYTES);
    const exact = await resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([attachment("audio", "audio-boundary", "audio/wav")]),
      audios: { "audio-boundary": { id: "audio-boundary", mime_type: "audio/wav", size_bytes: audioBoundary.byteLength } },
      files: { "audio-boundary": audioBoundary },
    }));
    expect(exact.byMessageId["message-1"]?.[0]?.byteLength).toBe(MAX_AUDIO_BYTES);

    let reads = 0;
    await expectProjectionError(resolveNativeCurrentTurnMedia("user-1", "chat-1", ["message-1"], authority({
      message: fixtureMessage([attachment("audio", "audio-over", "audio/wav")]),
      audios: { "audio-over": { id: "audio-over", mime_type: "audio/wav", size_bytes: MAX_AUDIO_BYTES + 1 } },
      files: { "audio-over": WAV },
      onRead: () => { reads += 1; },
    })), "limit_exceeded");
    expect(reads).toBe(0);
  });
});
