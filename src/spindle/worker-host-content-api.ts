import type {
  ActivatedWorldInfoEntryDTO,
  CharacterAvatarUploadDTO,
  CharacterDTO,
  ChatDTO,
  DatabankDocumentCreateDTO,
  DatabankDocumentDTO,
  DatabankDTO,
  GlobalAddonDTO,
  ImageDTO,
  ImageUploadDTO,
  PersonaDTO,
  RegexScopeDTO,
  RegexScriptDTO,
  RegexTargetDTO,
  WorldBookDTO,
  WorldBookEntryDTO,
} from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import * as spindleUploads from "./uploads";
import * as charactersSvc from "../services/characters.service";
import * as chatsSvc from "../services/chats.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import * as worldBooksSvc from "../services/world-books.service";
import { pruneOrphanedWiState } from "../services/wi-state-prune.service";
import * as regexScriptsSvc from "../services/regex-scripts.service";
import * as databanksSvc from "../services/databank";
import * as filesSvc from "../services/files.service";
import * as personasSvc from "../services/personas.service";
import * as globalAddonsSvc from "../services/global-addons.service";
import * as settingsSvc from "../services/settings.service";
import * as imagesSvc from "../services/images.service";
import * as mediaSvc from "../services/media.service";
import * as audioSvc from "../services/audio.service";
import * as promptAssemblySvc from "../services/prompt-assembly.service";
import { getDb } from "../db/connection";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";
import { tmpdir } from "os";

type ContentPermission = "characters" | "images" | "media" | "chats" | "world_books" | "databanks" | "personas" | "regex_scripts";
type ResolvedWorkerMediaSource = mediaSvc.ResolvedMediaSourceDTO & { cleanup?: () => void };

export type WorkerHostContentApiContext = {
  manifest: { identifier: string };
  hasPermission: (permission: ContentPermission) => boolean;
  resolveEffectiveUserId: (requestUserId?: string) => string | null;
  enforceScopedUser: (userId: string | null | undefined) => void;
  postResponse: (message: { type: "response"; requestId: string; result?: unknown; error?: string }) => void;
};

/** Content CRUD and media conversion surface exposed to one Spindle extension. */
export class WorkerHostContentApi {
  constructor(private readonly context: WorkerHostContentApiContext) {}

  private get manifest(): { identifier: string } { return this.context.manifest; }
  private hasPermission(permission: ContentPermission): boolean { return this.context.hasPermission(permission); }
  private resolveEffectiveUserId(userId?: string): string | null { return this.context.resolveEffectiveUserId(userId); }
  private enforceScopedUser(userId: string | null | undefined): void { this.context.enforceScopedUser(userId); }
  private postToWorker(message: { type: "response"; requestId: string; result?: unknown; error?: string }): void { this.context.postResponse(message); }

  private toCharacterDTO(c: any): CharacterDTO {
    return {
      id: c.id,
      name: c.name,
      description: c.description || "",
      personality: c.personality || "",
      scenario: c.scenario || "",
      first_mes: c.first_mes || "",
      mes_example: c.mes_example || "",
      creator_notes: c.creator_notes || "",
      system_prompt: c.system_prompt || "",
      post_history_instructions: c.post_history_instructions || "",
      tags: Array.isArray(c.tags) ? c.tags : [],
      alternate_greetings: Array.isArray(c.alternate_greetings) ? c.alternate_greetings : [],
      creator: c.creator || "",
      image_id: c.image_id || null,
      world_book_ids: getCharacterWorldBookIds(c.extensions),
      extensions: c.extensions || {},
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  /**
   * Normalize and dedupe a `world_book_ids` input from an extension. Filters
   * out non-string and empty entries, deduplicates while preserving order.
   */
  private sanitizeWorldBookIds(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of input) {
      if (typeof id !== "string" || !id.trim()) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  handleCharactersList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      if (!this.hasPermission("characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = charactersSvc.listCharacters(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((c) => this.toCharacterDTO(c)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleCharactersGet(requestId: string, characterId: string, userId?: string): void {
    try {
      if (!this.hasPermission("characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const c = charactersSvc.getCharacter(resolvedUserId, characterId);
      this.postToWorker({
        type: "response",
        requestId,
        result: c ? this.toCharacterDTO(c) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleCharactersCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Character name is required");
      }

      const createInput: any = {
        name: input.name,
        description: input.description,
        personality: input.personality,
        scenario: input.scenario,
        first_mes: input.first_mes,
        mes_example: input.mes_example,
        creator_notes: input.creator_notes,
        system_prompt: input.system_prompt,
        post_history_instructions: input.post_history_instructions,
        tags: input.tags,
        alternate_greetings: input.alternate_greetings,
        creator: input.creator,
      };
      if (input.world_book_ids !== undefined || input.extensions !== undefined) {
        const ids = this.sanitizeWorldBookIds(input.world_book_ids);
        createInput.extensions = setCharacterWorldBookIds(
          input.extensions && typeof input.extensions === "object" && !Array.isArray(input.extensions)
            ? input.extensions
            : {},
          ids,
        );
      }
      const c = charactersSvc.createCharacter(resolvedUserId, createInput);
      this.postToWorker({ type: "response", requestId, result: this.toCharacterDTO(c) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleCharactersSetAvatar(
    requestId: string,
    characterId: string,
    avatar: CharacterAvatarUploadDTO,
    userId?: string,
  ): void {
    (async () => {
      try {
        if (!this.hasPermission("characters")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        if (!(avatar?.data instanceof Uint8Array) || avatar.data.byteLength === 0) {
          throw new Error("Avatar data must be a non-empty Uint8Array");
        }

        const mimeType = typeof avatar.mime_type === "string" && avatar.mime_type.trim()
          ? avatar.mime_type.trim()
          : "image/png";
        const filename = typeof avatar.filename === "string" && avatar.filename.trim()
          ? avatar.filename.trim()
          : "avatar.png";

        const avatarBytes = Uint8Array.from(avatar.data);
        const file = new File([avatarBytes.buffer], filename, { type: mimeType });
        const updated = await charactersSvc.replaceCharacterAvatar(resolvedUserId, characterId, file);
        if (!updated) throw new Error("Character not found");

        this.postToWorker({ type: "response", requestId, result: this.toCharacterDTO(updated) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleCharactersUpdate(requestId: string, characterId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const update: any = {};
      const passthroughFields = [
        "name", "description", "personality", "scenario", "first_mes",
        "mes_example", "creator_notes", "system_prompt", "post_history_instructions",
        "tags", "alternate_greetings", "creator",
      ] as const;
      for (const field of passthroughFields) {
        if (input?.[field] !== undefined) update[field] = input[field];
      }

      const existing = charactersSvc.getCharacter(resolvedUserId, characterId);
      if (!existing) throw new Error("Character not found");

      let mergedExtensions: Record<string, any> | undefined;
      if (input?.extensions !== undefined) {
        if (typeof input.extensions !== "object" || Array.isArray(input.extensions)) {
          throw new Error("extensions must be a plain object");
        }
        mergedExtensions = { ...existing.extensions, ...input.extensions };
      }

      if (input?.world_book_ids !== undefined) {
        const ids = this.sanitizeWorldBookIds(input.world_book_ids);
        update.extensions = setCharacterWorldBookIds(mergedExtensions || existing.extensions || {}, ids);
      } else if (mergedExtensions !== undefined) {
        update.extensions = mergedExtensions;
      }

      const c = charactersSvc.updateCharacter(resolvedUserId, characterId, update);
      if (!c) throw new Error("Character not found");
      this.postToWorker({ type: "response", requestId, result: this.toCharacterDTO(c) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleCharactersDelete(requestId: string, characterId: string, userId?: string): void {
    try {
      if (!this.hasPermission("characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = charactersSvc.deleteCharacter(resolvedUserId, characterId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Images CRUD (gated: "images") ─────────────────────────────────

  private toImageDTO(img: any): ImageDTO {
    return {
      id: img.id,
      original_filename: img.original_filename || "",
      mime_type: img.mime_type || "",
      width: img.width ?? null,
      height: img.height ?? null,
      has_thumbnail: !!img.has_thumbnail,
      url: img.url,
      specificity: img.specificity || "full",
      owner_extension_identifier: img.owner_extension_identifier ?? null,
      owner_character_id: img.owner_character_id ?? null,
      owner_chat_id: img.owner_chat_id ?? null,
      created_at: img.created_at,
    };
  }

  handleImagesList(
    requestId: string,
    limit?: number,
    offset?: number,
    specificity?: imagesSvc.ImageSpecificity,
    onlyOwned?: boolean,
    characterId?: string,
    chatId?: string,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("images")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = imagesSvc.listImages(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
        specificity: specificity || "full",
        owner_extension_identifier: onlyOwned ? this.manifest.identifier : undefined,
        owner_character_id: characterId,
        owner_chat_id: chatId,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((img) => this.toImageDTO(img)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleImagesGet(
    requestId: string,
    imageId: string,
    specificity?: imagesSvc.ImageSpecificity,
    onlyOwned?: boolean,
    characterId?: string,
    chatId?: string,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("images")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const img = imagesSvc.getImage(resolvedUserId, imageId, {
        specificity: specificity || "full",
        owner_extension_identifier: onlyOwned ? this.manifest.identifier : undefined,
        owner_character_id: characterId,
        owner_chat_id: chatId,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: img ? this.toImageDTO(img) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleImagesUpload(requestId: string, input: any, userId?: string): void {
    (async () => {
      try {
        if (!this.hasPermission("images")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        if (!(input?.data instanceof Uint8Array) || input.data.byteLength === 0) {
          throw new Error("Image data must be a non-empty Uint8Array");
        }

        const mimeType = typeof input?.mime_type === "string" && input.mime_type.trim()
          ? input.mime_type.trim()
          : "image/png";
        const filename = typeof input?.filename === "string" && input.filename.trim()
          ? input.filename.trim()
          : "image.png";

        const imageBytes = Uint8Array.from(input.data);
        const file = new File([imageBytes.buffer], filename, { type: mimeType });
        const img = await imagesSvc.uploadImage(resolvedUserId, file, {
          owner_extension_identifier: this.manifest.identifier,
          owner_character_id: typeof input?.owner_character_id === "string" && input.owner_character_id.trim()
            ? input.owner_character_id.trim()
            : undefined,
          owner_chat_id: typeof input?.owner_chat_id === "string" && input.owner_chat_id.trim()
            ? input.owner_chat_id.trim()
            : undefined,
        });

        this.postToWorker({ type: "response", requestId, result: this.toImageDTO(img) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleImagesUploadMany(
    requestId: string,
    items: any[],
    userId?: string,
    concurrency?: number,
  ): void {
    (async () => {
      try {
        if (!this.hasPermission("images")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        if (!Array.isArray(items)) {
          throw new Error("items must be an array of ImageUploadDTO");
        }

        const normalised: imagesSvc.UploadImagesItem[] = new Array(items.length);
        const failures: Array<{ index: number; error: string }> = [];
        for (let i = 0; i < items.length; i++) {
          const input = items[i];
          if (!input || typeof input !== "object") {
            failures.push({ index: i, error: "item must be an object" });
            continue;
          }
          if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0) {
            failures.push({ index: i, error: "Image data must be a non-empty Uint8Array" });
            continue;
          }
          normalised[i] = {
            data: input.data,
            filename: typeof input.filename === "string" && input.filename.trim()
              ? input.filename.trim()
              : "image.png",
            mime_type: typeof input.mime_type === "string" && input.mime_type.trim()
              ? input.mime_type.trim()
              : "image/png",
            ...(typeof input.owner_character_id === "string" && input.owner_character_id.trim()
              ? { owner_character_id: input.owner_character_id.trim() }
              : {}),
            ...(typeof input.owner_chat_id === "string" && input.owner_chat_id.trim()
              ? { owner_chat_id: input.owner_chat_id.trim() }
              : {}),
          };
        }

        const validIndices: number[] = [];
        const validItems: imagesSvc.UploadImagesItem[] = [];
        for (let i = 0; i < normalised.length; i++) {
          if (normalised[i] !== undefined) {
            validIndices.push(i);
            validItems.push(normalised[i]!);
          }
        }

        const batchResults = await imagesSvc.uploadImages(resolvedUserId, validItems, {
          owner_extension_identifier: this.manifest.identifier,
          concurrency,
        });

        const results: Array<{ id?: string; error?: string }> = new Array(items.length);
        for (const f of failures) results[f.index] = { error: f.error };
        for (let k = 0; k < validIndices.length; k++) {
          const out = batchResults[k]!;
          results[validIndices[k]!] = out.id !== undefined
            ? { id: out.id }
            : { error: out.error ?? "unknown error" };
        }

        this.postToWorker({ type: "response", requestId, result: results });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleImagesUploadFromDataUrl(
    requestId: string,
    dataUrl: string,
    originalFilename?: string,
    ownerCharacterId?: string,
    ownerChatId?: string,
    userId?: string,
  ): void {
    (async () => {
      try {
        if (!this.hasPermission("images")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        if (typeof dataUrl !== "string" || !dataUrl.trim()) {
          throw new Error("dataUrl is required");
        }

        const img = await imagesSvc.saveImageFromDataUrl(resolvedUserId, dataUrl, originalFilename, {
          owner_extension_identifier: this.manifest.identifier,
          owner_character_id: typeof ownerCharacterId === "string" && ownerCharacterId.trim()
            ? ownerCharacterId.trim()
            : undefined,
          owner_chat_id: typeof ownerChatId === "string" && ownerChatId.trim()
            ? ownerChatId.trim()
            : undefined,
        });
        this.postToWorker({ type: "response", requestId, result: this.toImageDTO(img) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleImagesDelete(requestId: string, imageId: string, userId?: string): void {
    try {
      if (!this.hasPermission("images")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = imagesSvc.deleteImage(resolvedUserId, imageId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleImagesDeleteMany(requestId: string, imageIds: string[], userId?: string): void {
    void (async () => {
      try {
        if (!this.hasPermission("images")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);
        if (!Array.isArray(imageIds)) throw new Error("imageIds must be an array");

        const deleted = await imagesSvc.deleteImagesBulk(resolvedUserId, imageIds);
        this.postToWorker({ type: "response", requestId, result: deleted });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  private tempExtensionForMediaSource(filename?: string, mimeType?: string): string {
    const explicit = extname(filename || "").trim().toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(explicit)) return explicit;

    switch ((mimeType || "").trim().toLowerCase()) {
      case "video/mp4":
        return ".mp4";
      case "video/webm":
        return ".webm";
      case "video/quicktime":
        return ".mov";
      case "video/x-m4v":
        return ".m4v";
      case "video/x-matroska":
        return ".mkv";
      case "audio/mpeg":
      case "audio/mp3":
        return ".mp3";
      case "audio/wav":
      case "audio/x-wav":
        return ".wav";
      case "audio/ogg":
      case "audio/ogg; codecs=opus":
      case "audio/opus":
        return ".ogg";
      case "audio/aac":
        return ".aac";
      case "audio/flac":
        return ".flac";
      case "audio/mp4":
        return ".m4a";
      case "audio/webm":
        return ".webm";
      case "image/png":
        return ".png";
      case "image/jpeg":
        return ".jpg";
      case "image/webp":
        return ".webp";
      case "image/gif":
        return ".gif";
      case "image/avif":
        return ".avif";
      case "image/svg+xml":
        return ".svg";
      default:
        return ".bin";
    }
  }

  private async resolveMediaSource(
    source: mediaSvc.MediaSourceDTO,
    resolvedUserId: string,
  ): Promise<ResolvedWorkerMediaSource> {
    if (!source || typeof source !== "object") {
      throw new Error("input.source is required");
    }

    switch (source.kind) {
      case "inline": {
        if (!(source.data instanceof Uint8Array) || source.data.byteLength === 0) {
          throw new Error("inline media source data must be a non-empty Uint8Array");
        }
        const workdir = mkdtempSync(join(tmpdir(), "lumiverse-spindle-media-src-"));
        const filename = typeof source.filename === "string" && source.filename.trim()
          ? source.filename.trim()
          : `inline${this.tempExtensionForMediaSource(undefined, source.mime_type)}`;
        const ext = this.tempExtensionForMediaSource(filename, source.mime_type);
        const path = join(workdir, `input${ext}`);
        await Bun.write(path, source.data);
        return {
          path,
          filename,
          mime_type: typeof source.mime_type === "string" && source.mime_type.trim()
            ? source.mime_type.trim()
            : undefined,
          cleanup: () => {
            try {
              rmSync(workdir, { recursive: true, force: true });
            } catch {
              /* ignore cleanup failure */
            }
          },
        };
      }
      case "upload": {
        const uploadId = typeof source.upload_id === "string" ? source.upload_id.trim() : "";
        if (!uploadId) throw new Error("upload media source requires upload_id");
        const rec = spindleUploads.getUpload(uploadId);
        if (!rec || rec.ownerUserId !== resolvedUserId || rec.extensionIdentifier !== this.manifest.identifier) {
          throw new Error("upload media source not found");
        }
        return {
          path: rec.path,
          filename: (typeof source.filename === "string" && source.filename.trim()) ? source.filename.trim() : rec.fileName,
          mime_type: typeof source.mime_type === "string" && source.mime_type.trim()
            ? source.mime_type.trim()
            : undefined,
        };
      }
      case "image": {
        const imageId = typeof source.image_id === "string" ? source.image_id.trim() : "";
        if (!imageId) throw new Error("image media source requires image_id");
        const image = imagesSvc.getImage(resolvedUserId, imageId);
        if (!image) throw new Error("image media source not found");
        const path = await imagesSvc.getImageFilePath(resolvedUserId, imageId);
        if (!path) throw new Error("image media source file not found");
        return {
          path,
          filename: image.original_filename || image.id,
          mime_type: image.mime_type || undefined,
        };
      }
      case "audio": {
        const audioId = typeof source.audio_id === "string" ? source.audio_id.trim() : "";
        if (!audioId) throw new Error("audio media source requires audio_id");
        const audio = audioSvc.getAudio(resolvedUserId, audioId);
        if (!audio) throw new Error("audio media source not found");
        const path = audioSvc.getAudioFilePath(resolvedUserId, audioId);
        if (!path) throw new Error("audio media source file not found");
        return {
          path,
          filename: audio.original_filename || audio.filename,
          mime_type: audio.mime_type || undefined,
        };
      }
      default:
        throw new Error("unsupported media source kind");
    }
  }

  private cleanupResolvedMediaSource(source: ResolvedWorkerMediaSource | null | undefined): void {
    try {
      source?.cleanup?.();
    } catch {
      /* ignore cleanup failure */
    }
  }

  handleMediaAudioConvert(requestId: string, input: mediaSvc.MediaConvertAudioRequestDTO): void {
    (async () => {
      let source: ResolvedWorkerMediaSource | null = null;
      try {
        if (!this.hasPermission("media")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} media — Media permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(input?.userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        source = await this.resolveMediaSource(input?.source as mediaSvc.MediaSourceDTO, resolvedUserId);
        const result = await mediaSvc.convertAudio(source, input);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
      } finally {
        this.cleanupResolvedMediaSource(source);
      }
    })();
  }

  handleMediaVideoConvert(requestId: string, input: mediaSvc.MediaConvertVideoRequestDTO): void {
    (async () => {
      let source: ResolvedWorkerMediaSource | null = null;
      try {
        if (!this.hasPermission("media")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} media — Media permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(input?.userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        source = await this.resolveMediaSource(input?.source as mediaSvc.MediaSourceDTO, resolvedUserId);
        mediaSvc.assertLikelyVideoSource(source);
        const result = await mediaSvc.convertVideo(source, input);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
      } finally {
        this.cleanupResolvedMediaSource(source);
      }
    })();
  }

  handleMediaVideoTranscode(requestId: string, input: mediaSvc.MediaTranscodeVideoRequestDTO): void {
    (async () => {
      let source: ResolvedWorkerMediaSource | null = null;
      try {
        if (!this.hasPermission("media")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} media — Media permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(input?.userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        source = await this.resolveMediaSource(input?.source as mediaSvc.MediaSourceDTO, resolvedUserId);
        mediaSvc.assertLikelyVideoSource(source);
        const result = await mediaSvc.transcodeVideo(source, input);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
      } finally {
        this.cleanupResolvedMediaSource(source);
      }
    })();
  }

  handleMediaVideoRemoveAudio(requestId: string, input: mediaSvc.MediaRemoveAudioFromVideoRequestDTO): void {
    (async () => {
      let source: ResolvedWorkerMediaSource | null = null;
      try {
        if (!this.hasPermission("media")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} media — Media permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(input?.userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        source = await this.resolveMediaSource(input?.source as mediaSvc.MediaSourceDTO, resolvedUserId);
        mediaSvc.assertLikelyVideoSource(source);
        const result = await mediaSvc.removeAudioFromVideo(source, input);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
      } finally {
        this.cleanupResolvedMediaSource(source);
      }
    })();
  }

  handleMediaVideoAddAudio(requestId: string, input: mediaSvc.MediaAddAudioToVideoRequestDTO): void {
    (async () => {
      let video: ResolvedWorkerMediaSource | null = null;
      let audio: ResolvedWorkerMediaSource | null = null;
      try {
        if (!this.hasPermission("media")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} media — Media permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(input?.userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        video = await this.resolveMediaSource(input?.video as mediaSvc.MediaSourceDTO, resolvedUserId);
        audio = await this.resolveMediaSource(input?.audio as mediaSvc.MediaSourceDTO, resolvedUserId);
        mediaSvc.assertLikelyVideoSource(video, "video");
        const result = await mediaSvc.addAudioToVideo(video, audio, input);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
      } finally {
        this.cleanupResolvedMediaSource(video);
        this.cleanupResolvedMediaSource(audio);
      }
    })();
  }

  handleMediaVideoFromImageAudio(requestId: string, input: mediaSvc.MediaCreateVideoFromImageAndAudioRequestDTO): void {
    (async () => {
      let image: ResolvedWorkerMediaSource | null = null;
      let audio: ResolvedWorkerMediaSource | null = null;
      try {
        if (!this.hasPermission("media")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} media — Media permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(input?.userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        image = await this.resolveMediaSource(input?.image as mediaSvc.MediaSourceDTO, resolvedUserId);
        audio = await this.resolveMediaSource(input?.audio as mediaSvc.MediaSourceDTO, resolvedUserId);
        mediaSvc.assertLikelyImageSource(image, "image");
        const result = await mediaSvc.createVideoFromImageAndAudio(image, audio, input);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
      } finally {
        this.cleanupResolvedMediaSource(image);
        this.cleanupResolvedMediaSource(audio);
      }
    })();
  }

  // ─── Chats CRUD (gated: "chats") ──────────────────────────────────

  private toChatDTO(c: any): ChatDTO {
    return {
      id: c.id,
      character_id: c.character_id,
      name: c.name || "",
      metadata: (typeof c.metadata === "object" && c.metadata) ? c.metadata : {},
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  handleChatsList(
    requestId: string,
    characterId?: string,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = chatsSvc.listChats(
        resolvedUserId,
        { limit: Math.min(limit || 50, 200), offset: offset || 0 },
        characterId,
      );
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((c) => this.toChatDTO(c)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleChatsGet(requestId: string, chatId: string, userId?: string): void {
    try {
      if (!this.hasPermission("chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const c = chatsSvc.getChat(resolvedUserId, chatId);
      this.postToWorker({ type: "response", requestId, result: c ? this.toChatDTO(c) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleChatsGetActive(requestId: string, userId?: string): void {
    try {
      if (!this.hasPermission("chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const setting = settingsSvc.getSetting(resolvedUserId, "activeChatId");
      if (!setting?.value || typeof setting.value !== "string") {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }

      const chat = chatsSvc.getChat(resolvedUserId, setting.value);
      this.postToWorker({ type: "response", requestId, result: chat ? this.toChatDTO(chat) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleChatsUpdate(requestId: string, chatId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const before = chatsSvc.getChat(resolvedUserId, chatId);
      let c = chatsSvc.updateChat(resolvedUserId, chatId, input || {});
      if (!c) throw new Error("Chat not found");
      // Spindle metadata updates are full replaces, so book attachments can
      // change (or vanish) on any metadata write — mirror the REST routes'
      // orphaned wi_state pruning.
      if (input?.metadata !== undefined) {
        const beforeIds = JSON.stringify(before?.metadata?.chat_world_book_ids ?? []);
        const afterIds = JSON.stringify(c.metadata?.chat_world_book_ids ?? []);
        if (beforeIds !== afterIds) {
          c = pruneOrphanedWiState(resolvedUserId, c);
        }
      }
      this.postToWorker({ type: "response", requestId, result: this.toChatDTO(c) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleChatsDelete(requestId: string, chatId: string, userId?: string): void {
    try {
      if (!this.hasPermission("chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = chatsSvc.deleteChat(resolvedUserId, chatId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── World Books CRUD (gated: "world_books") ─────────────────────────

  private toWorldBookDTO(wb: any): WorldBookDTO {
    return {
      id: wb.id,
      name: wb.name || "",
      description: wb.description || "",
      metadata: (typeof wb.metadata === "object" && wb.metadata) ? wb.metadata : {},
      created_at: wb.created_at,
      updated_at: wb.updated_at,
    };
  }

  private toWorldBookEntryDTO(e: any): WorldBookEntryDTO {
    return {
      id: e.id,
      world_book_id: e.world_book_id,
      uid: e.uid || "",
      key: Array.isArray(e.key) ? e.key : [],
      keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
      content: e.content || "",
      comment: e.comment || "",
      position: e.position ?? 0,
      depth: e.depth ?? 4,
      role: e.role || null,
      order_value: e.order_value ?? 100,
      selective: !!e.selective,
      constant: !!e.constant,
      disabled: !!e.disabled,
      group_name: e.group_name || "",
      group_override: !!e.group_override,
      group_weight: e.group_weight ?? 100,
      probability: e.probability ?? 100,
      scan_depth: e.scan_depth ?? null,
      case_sensitive: !!e.case_sensitive,
      match_whole_words: !!e.match_whole_words,
      automation_id: e.automation_id || null,
      use_regex: !!e.use_regex,
      prevent_recursion: !!e.prevent_recursion,
      exclude_recursion: !!e.exclude_recursion,
      delay_until_recursion: !!e.delay_until_recursion,
      priority: e.priority ?? 10,
      sticky: e.sticky ?? 0,
      cooldown: e.cooldown ?? 0,
      delay: e.delay ?? 0,
      selective_logic: e.selective_logic ?? 0,
      use_probability: e.use_probability !== undefined ? !!e.use_probability : true,
      vectorized: !!e.vectorized,
      extensions: (typeof e.extensions === "object" && e.extensions) ? e.extensions : {},
      created_at: e.created_at,
      updated_at: e.updated_at,
    };
  }

  handleWorldBooksList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = worldBooksSvc.listWorldBooks(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((wb) => this.toWorldBookDTO(wb)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBooksGet(requestId: string, worldBookId: string, userId?: string): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const wb = worldBooksSvc.getWorldBook(resolvedUserId, worldBookId);
      this.postToWorker({ type: "response", requestId, result: wb ? this.toWorldBookDTO(wb) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBooksCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("World book name is required");
      }

      const wb = worldBooksSvc.createWorldBook(resolvedUserId, {
        name: input.name,
        description: input.description,
        metadata: input.metadata,
      });
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookDTO(wb) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBooksUpdate(requestId: string, worldBookId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const wb = worldBooksSvc.updateWorldBook(resolvedUserId, worldBookId, input || {});
      if (!wb) throw new Error("World book not found");
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookDTO(wb) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handleWorldBooksDelete(requestId: string, worldBookId: string, userId?: string): Promise<void> {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = await worldBooksSvc.deleteWorldBook(resolvedUserId, worldBookId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── World Book Entries CRUD (gated: "world_books") ───────────────────

  handleWorldBookEntriesList(
    requestId: string,
    worldBookId: string,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = worldBooksSvc.listEntriesPaginated(resolvedUserId, worldBookId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((e) => this.toWorldBookEntryDTO(e)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBookEntriesGet(requestId: string, entryId: string, userId?: string): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const entry = worldBooksSvc.getEntry(resolvedUserId, entryId);
      this.postToWorker({ type: "response", requestId, result: entry ? this.toWorldBookEntryDTO(entry) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBookEntriesCreate(requestId: string, worldBookId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const entry = worldBooksSvc.createEntry(resolvedUserId, worldBookId, input || {});
      if (!entry) throw new Error("World book not found");
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookEntryDTO(entry) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBookEntriesUpdate(requestId: string, entryId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const entry = worldBooksSvc.updateEntry(resolvedUserId, entryId, input || {});
      if (!entry) throw new Error("World book entry not found");
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookEntryDTO(entry) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handleWorldBookEntriesDelete(requestId: string, entryId: string, userId?: string): Promise<void> {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = await worldBooksSvc.deleteEntry(resolvedUserId, entryId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Databanks CRUD (gated: "databanks") ─────────────────────────────

  private toDatabankDTO(bank: any): DatabankDTO {
    return {
      id: bank.id,
      name: bank.name || "",
      description: bank.description || "",
      scope: bank.scope,
      scope_id: bank.scopeId ?? null,
      enabled: !!bank.enabled,
      metadata: (typeof bank.metadata === "object" && bank.metadata) ? bank.metadata : {},
      document_count: typeof bank.documentCount === "number" ? bank.documentCount : undefined,
      created_at: bank.createdAt,
      updated_at: bank.updatedAt,
    };
  }

  private toDatabankDocumentDTO(doc: any): DatabankDocumentDTO {
    return {
      id: doc.id,
      databank_id: doc.databankId,
      name: doc.name || "",
      slug: doc.slug || "",
      mime_type: doc.mimeType || "",
      file_size: doc.fileSize ?? 0,
      content_hash: doc.contentHash || "",
      total_chunks: doc.totalChunks ?? 0,
      status: doc.status,
      error_message: doc.errorMessage ?? null,
      metadata: (typeof doc.metadata === "object" && doc.metadata) ? doc.metadata : {},
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    };
  }

  handleDatabanksList(
    requestId: string,
    limit?: number,
    offset?: number,
    scope?: string,
    scopeId?: string | null,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const normalizedScope =
        scope === undefined
          ? undefined
          : scope === "global" || scope === "character" || scope === "chat"
            ? scope
            : null;
      if (normalizedScope === null) throw new Error("Databank scope must be 'global', 'character', or 'chat'");

      const result = databanksSvc.listDatabanks(
        resolvedUserId,
        {
          limit: Math.min(limit || 50, 200),
          offset: offset || 0,
        },
        {
          scope: normalizedScope,
          scopeId: typeof scopeId === "string" ? scopeId : undefined,
        },
      );
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((bank) => this.toDatabankDTO(bank)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabanksGet(requestId: string, databankId: string, userId?: string): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const bank = databanksSvc.getDatabank(resolvedUserId, databankId);
      this.postToWorker({ type: "response", requestId, result: bank ? this.toDatabankDTO(bank) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabanksCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Databank name is required");
      }
      if (input.scope !== "global" && input.scope !== "character" && input.scope !== "chat") {
        throw new Error("Databank scope must be 'global', 'character', or 'chat'");
      }
      if (input.scope !== "global" && (!input.scope_id || typeof input.scope_id !== "string")) {
        throw new Error("scope_id is required for character and chat databanks");
      }

      const bank = databanksSvc.createDatabank(resolvedUserId, {
        name: input.name.trim(),
        description: typeof input.description === "string" ? input.description : undefined,
        scope: input.scope,
        scopeId: input.scope_id ?? null,
      });
      this.postToWorker({ type: "response", requestId, result: this.toDatabankDTO(bank) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabanksUpdate(requestId: string, databankId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const bank = databanksSvc.updateDatabank(resolvedUserId, databankId, {
        name: typeof input?.name === "string" ? input.name : undefined,
        description: typeof input?.description === "string" ? input.description : undefined,
        enabled: typeof input?.enabled === "boolean" ? input.enabled : undefined,
      });
      if (!bank) throw new Error("Databank not found");

      this.postToWorker({ type: "response", requestId, result: this.toDatabankDTO(bank) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabanksDelete(requestId: string, databankId: string, userId?: string): void {
    (async () => {
      try {
        if (!this.hasPermission("databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        databanksSvc.abortDatabankProcessing(databankId);
        await databanksSvc.deleteDatabankVectors(resolvedUserId, databankId);
        const deleted = await databanksSvc.deleteDatabank(resolvedUserId, databankId);
        this.postToWorker({ type: "response", requestId, result: deleted });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  // ─── Databank Documents CRUD (gated: "databanks") ────────────────────

  handleDatabankDocumentsList(
    requestId: string,
    databankId: string,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = databanksSvc.listDocuments(resolvedUserId, databankId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((doc) => this.toDatabankDocumentDTO(doc)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabankDocumentsGet(requestId: string, documentId: string, userId?: string): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const doc = databanksSvc.getDocument(resolvedUserId, documentId);
      this.postToWorker({ type: "response", requestId, result: doc ? this.toDatabankDocumentDTO(doc) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabankDocumentsCreate(
    requestId: string,
    databankId: string,
    input: DatabankDocumentCreateDTO,
    userId?: string,
  ): void {
    (async () => {
      try {
        if (!this.hasPermission("databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        const bank = databanksSvc.getDatabank(resolvedUserId, databankId);
        if (!bank) throw new Error("Databank not found");
        if (!(input?.data instanceof Uint8Array) || input.data.byteLength === 0) {
          throw new Error("Document data must be a non-empty Uint8Array");
        }
        if (!input.filename || typeof input.filename !== "string" || !input.filename.trim()) {
          throw new Error("Document filename is required");
        }
        const filename = input.filename.trim();
        if (!databanksSvc.isSupportedFormat(filename)) {
          throw new Error(`Unsupported file format. Supported: ${databanksSvc.getSupportedExtensions().join(", ")}`);
        }
        if (input.data.byteLength > 10 * 1024 * 1024) {
          throw new Error("File too large. Maximum 10MB.");
        }

        const bytes = Uint8Array.from(input.data);
        const mimeType = typeof input.mime_type === "string" ? input.mime_type.trim() : "";
        const file = new File([bytes], filename, { type: mimeType || "application/octet-stream" });
        const storedFilename = await filesSvc.saveUpload(file, resolvedUserId, "databank");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const displayName = typeof input.name === "string" && input.name.trim()
          ? input.name.trim()
          : filename.replace(/\.[^.]+$/, "");

        const doc = databanksSvc.createDocument(
          resolvedUserId,
          databankId,
          displayName,
          storedFilename,
          mimeType,
          bytes.byteLength,
          hash,
        );

        databanksSvc.processDocument(resolvedUserId, doc.id).catch((err) => {
          console.error(`[databank] Background processing failed for ${doc.id}:`, err);
        });

        this.postToWorker({ type: "response", requestId, result: this.toDatabankDocumentDTO(doc) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleDatabankDocumentsUpdate(requestId: string, documentId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Document name is required");
      }

      const doc = databanksSvc.renameDocument(resolvedUserId, documentId, input.name.trim());
      if (!doc) throw new Error("Document not found");

      this.postToWorker({ type: "response", requestId, result: this.toDatabankDocumentDTO(doc) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabankDocumentsDelete(requestId: string, documentId: string, userId?: string): void {
    (async () => {
      try {
        if (!this.hasPermission("databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        databanksSvc.abortDocumentProcessing(documentId);
        await databanksSvc.deleteDocumentVectors(resolvedUserId, documentId);
        const deleted = await databanksSvc.deleteDocument(resolvedUserId, documentId);
        this.postToWorker({ type: "response", requestId, result: deleted });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleDatabankDocumentsGetContent(requestId: string, documentId: string, userId?: string): void {
    try {
      if (!this.hasPermission("databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const content = databanksSvc.getDocumentContent(resolvedUserId, documentId);
      this.postToWorker({
        type: "response",
        requestId,
        result: content === null ? null : { content },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleDatabankDocumentsReprocess(requestId: string, documentId: string, userId?: string): void {
    (async () => {
      try {
        if (!this.hasPermission("databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        const doc = databanksSvc.getDocument(resolvedUserId, documentId);
        if (!doc) throw new Error("Document not found");

        await databanksSvc.deleteDocumentVectors(resolvedUserId, documentId);
        databanksSvc.updateDocumentStatus(documentId, "pending");
        databanksSvc.processDocument(resolvedUserId, documentId).catch((err) => {
          console.error(`[databank] Reprocessing failed for ${documentId}:`, err);
        });

        this.postToWorker({ type: "response", requestId, result: { success: true, status: "processing" } });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  // ─── Personas CRUD (gated: "personas") ────────────────────────────────

  private toPersonaDTO(p: any): PersonaDTO {
    return {
      id: p.id,
      name: p.name || "",
      title: p.title || "",
      description: p.description || "",
      image_id: p.image_id || null,
      attached_world_book_id: p.attached_world_book_id || null,
      folder: p.folder || "",
      is_default: !!p.is_default,
      metadata: (typeof p.metadata === "object" && p.metadata) ? p.metadata : {},
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }

  handlePersonasList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = personasSvc.listPersonas(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((p) => this.toPersonaDTO(p)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasGet(requestId: string, personaId: string, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const p = personasSvc.getPersona(resolvedUserId, personaId);
      this.postToWorker({ type: "response", requestId, result: p ? this.toPersonaDTO(p) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasGetDefault(requestId: string, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const p = personasSvc.getDefaultPersona(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: p ? this.toPersonaDTO(p) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasGetActive(requestId: string, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const setting = settingsSvc.getSetting(resolvedUserId, "activePersonaId");
      if (!setting?.value || typeof setting.value !== "string") {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }

      const persona = personasSvc.getPersona(resolvedUserId, setting.value);
      this.postToWorker({ type: "response", requestId, result: persona ? this.toPersonaDTO(persona) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Persona name is required");
      }

      const p = personasSvc.createPersona(resolvedUserId, {
        name: input.name,
        title: input.title,
        description: input.description,
        folder: input.folder,
        is_default: input.is_default,
        attached_world_book_id: input.attached_world_book_id,
        metadata: input.metadata,
      });
      this.postToWorker({ type: "response", requestId, result: this.toPersonaDTO(p) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasUpdate(requestId: string, personaId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const p = personasSvc.updatePersona(resolvedUserId, personaId, input || {});
      if (!p) throw new Error("Persona not found");
      this.postToWorker({ type: "response", requestId, result: this.toPersonaDTO(p) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasDelete(requestId: string, personaId: string, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = personasSvc.deletePersona(resolvedUserId, personaId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasSwitch(requestId: string, personaId: string | null, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      // Validate persona exists if a non-null ID is provided
      if (personaId !== null) {
        const persona = personasSvc.getPersona(resolvedUserId, personaId);
        if (!persona) throw new Error("Persona not found");
      }

      // Set the activePersonaId setting (putSetting emits SETTINGS_UPDATED)
      settingsSvc.putSetting(resolvedUserId, "activePersonaId", personaId);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handlePersonasGetWorldBook(requestId: string, personaId: string, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const persona = personasSvc.getPersona(resolvedUserId, personaId);
      if (!persona) throw new Error("Persona not found");

      if (!persona.attached_world_book_id) {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }

      const wb = worldBooksSvc.getWorldBook(resolvedUserId, persona.attached_world_book_id);
      this.postToWorker({ type: "response", requestId, result: wb ? this.toWorldBookDTO(wb) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Global Add-ons (gated: "personas") ──────────────────────────────

  private toGlobalAddonDTO(a: any): GlobalAddonDTO {
    return {
      id: a.id,
      label: a.label || "",
      content: a.content || "",
      sort_order: a.sort_order ?? 0,
      metadata: (typeof a.metadata === "object" && a.metadata) ? a.metadata : {},
      created_at: a.created_at,
      updated_at: a.updated_at,
    };
  }

  handleGlobalAddonsList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = globalAddonsSvc.listGlobalAddons(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((a) => this.toGlobalAddonDTO(a)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleGlobalAddonsGet(requestId: string, addonId: string, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const addon = globalAddonsSvc.getGlobalAddon(resolvedUserId, addonId);
      this.postToWorker({ type: "response", requestId, result: addon ? this.toGlobalAddonDTO(addon) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleGlobalAddonsUpdate(requestId: string, addonId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const addon = globalAddonsSvc.updateGlobalAddon(resolvedUserId, addonId, input || {});
      if (!addon) throw new Error("Global add-on not found");
      this.postToWorker({ type: "response", requestId, result: this.toGlobalAddonDTO(addon) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Activated World Info (gated: "world_books") ─────────────────────

  async handleWorldBooksGetActivated(
    requestId: string,
    chatId: string,
    userId?: string,
  ): Promise<void> {
    try {
      if (!this.hasPermission("world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const activated = await promptAssemblySvc.getActivatedWorldInfoForChat(resolvedUserId, chatId);

      const result: ActivatedWorldInfoEntryDTO[] = activated.map((e) => ({
        id: e.id,
        comment: e.comment,
        keys: e.keys,
        source: e.source,
        score: e.score,
        bookId: e.bookId,
        // The published Spindle SDK's WorldBookSourceDTO has no "peer" variant
        // (a relayed multiplayer participant's persona lorebook). Surface it to
        // extensions as its closest valid kind — "persona" — rather than bumping
        // the SDK contract; the host's own Prompt Breakdown keeps the distinction.
        bookSource: e.bookSource === "peer" ? "persona" : e.bookSource,
      }));

      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Global World Books (gated: "world_books") ───────────────────────

  // Global activation lives in the per-user "globalWorldBooks" setting, the
  // same store the frontend World Book panel writes. putSetting emits
  // SETTINGS_UPDATED, which keeps open frontend tabs in sync.
  private readGlobalWorldBookIds(userId: string): string[] {
    const raw = settingsSvc.getSetting(userId, "globalWorldBooks")?.value;
    return this.sanitizeWorldBookIds(raw);
  }

  private requireWorldBooksUser(userId?: string): string {
    if (!this.hasPermission("world_books")) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
    }
    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
    this.enforceScopedUser(resolvedUserId);
    return resolvedUserId;
  }

  handleWorldBooksGetGlobal(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.requireWorldBooksUser(userId);
      this.postToWorker({ type: "response", requestId, result: this.readGlobalWorldBookIds(resolvedUserId) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBooksSetGlobal(requestId: string, worldBookIds: unknown, userId?: string): void {
    try {
      const resolvedUserId = this.requireWorldBooksUser(userId);
      // Drop IDs that don't resolve to an existing book rather than throwing:
      // the stored setting may carry stale IDs of since-deleted books, and a
      // round-tripped getGlobal() → setGlobal() must not fail because of them.
      const ids = this.sanitizeWorldBookIds(worldBookIds).filter((id) =>
        worldBooksSvc.getWorldBook(resolvedUserId, id),
      );
      settingsSvc.putSetting(resolvedUserId, "globalWorldBooks", ids);
      this.postToWorker({ type: "response", requestId, result: ids });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBooksActivateGlobal(requestId: string, worldBookId: unknown, userId?: string): void {
    try {
      const resolvedUserId = this.requireWorldBooksUser(userId);
      if (typeof worldBookId !== "string" || !worldBookId.trim()) {
        throw new Error("worldBookId is required");
      }
      if (!worldBooksSvc.getWorldBook(resolvedUserId, worldBookId)) {
        throw new Error("World book not found");
      }
      const ids = this.readGlobalWorldBookIds(resolvedUserId);
      if (!ids.includes(worldBookId)) {
        ids.push(worldBookId);
        settingsSvc.putSetting(resolvedUserId, "globalWorldBooks", ids);
      }
      this.postToWorker({ type: "response", requestId, result: ids });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleWorldBooksDeactivateGlobal(requestId: string, worldBookId: unknown, userId?: string): void {
    try {
      const resolvedUserId = this.requireWorldBooksUser(userId);
      if (typeof worldBookId !== "string" || !worldBookId.trim()) {
        throw new Error("worldBookId is required");
      }
      const current = this.readGlobalWorldBookIds(resolvedUserId);
      const ids = current.filter((id) => id !== worldBookId);
      if (ids.length !== current.length) {
        settingsSvc.putSetting(resolvedUserId, "globalWorldBooks", ids);
      }
      this.postToWorker({ type: "response", requestId, result: ids });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Regex Scripts (gated: "regex_scripts") ──────────────────────────

  private toRegexScriptDTO(s: any): RegexScriptDTO {
    return {
      id: s.id,
      name: s.name,
      script_id: s.script_id || "",
      find_regex: s.find_regex,
      replace_string: s.replace_string,
      actions: s.actions || [],
      flags: s.flags,
      placement: s.placement,
      scope: s.scope,
      scope_id: s.scope_id,
      target: s.target,
      min_depth: s.min_depth,
      max_depth: s.max_depth,
      trim_strings: s.trim_strings,
      run_on_edit: !!s.run_on_edit,
      substitute_macros: s.substitute_macros,
      disabled: !!s.disabled,
      sort_order: s.sort_order,
      description: s.description || "",
      folder: s.folder || "",
      metadata: s.metadata || {},
      created_at: s.created_at,
      updated_at: s.updated_at,
    } as RegexScriptDTO;
  }

  handleRegexScriptsList(
    requestId: string,
    scope?: RegexScopeDTO,
    scopeId?: string,
    target?: RegexTargetDTO,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (scope !== undefined && scope !== "global" && scope !== "character" && scope !== "chat") {
        throw new Error("scope must be 'global', 'character', or 'chat'");
      }
      if (target !== undefined && target !== "prompt" && target !== "response" && target !== "display") {
        throw new Error("target must be 'prompt', 'response', or 'display'");
      }

      const filters: { scope?: RegexScopeDTO; scope_id?: string; target?: RegexTargetDTO } = {};
      if (target) filters.target = target;
      if (scope) filters.scope = scope;
      if (scopeId) filters.scope_id = scopeId;

      const result = regexScriptsSvc.listRegexScripts(
        resolvedUserId,
        { limit: Math.min(limit || 50, 200), offset: offset || 0 },
        filters,
      );
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((s) => this.toRegexScriptDTO(s)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleRegexScriptsGet(requestId: string, scriptId: string, userId?: string): void {
    try {
      if (!this.hasPermission("regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const s = regexScriptsSvc.getRegexScript(resolvedUserId, scriptId);
      this.postToWorker({ type: "response", requestId, result: s ? this.toRegexScriptDTO(s) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleRegexScriptsGetActive(
    requestId: string,
    target: RegexTargetDTO,
    characterId?: string,
    chatId?: string,
    userId?: string,
  ): void {
    try {
      if (!this.hasPermission("regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (target !== "prompt" && target !== "response" && target !== "display") {
        throw new Error("target must be 'prompt', 'response', or 'display'");
      }

      const scripts = regexScriptsSvc.getActiveScripts(resolvedUserId, { characterId, chatId, target });
      this.postToWorker({
        type: "response",
        requestId,
        result: scripts.map((s) => this.toRegexScriptDTO(s)),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleRegexScriptsCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Regex script name is required");
      }
      if (typeof input.find_regex !== "string") {
        throw new Error("find_regex is required");
      }

      const result = regexScriptsSvc.createRegexScript(resolvedUserId, input);
      if (typeof result === "string") throw new Error(result);
      this.postToWorker({ type: "response", requestId, result: this.toRegexScriptDTO(result) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleRegexScriptsUpdate(requestId: string, scriptId: string, input: any, userId?: string): void {
    try {
      if (!this.hasPermission("regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = regexScriptsSvc.updateRegexScript(resolvedUserId, scriptId, input || {});
      if (result === null) throw new Error("Regex script not found");
      if (typeof result === "string") throw new Error(result);
      this.postToWorker({ type: "response", requestId, result: this.toRegexScriptDTO(result) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleRegexScriptsDelete(requestId: string, scriptId: string, userId?: string): void {
    try {
      if (!this.hasPermission("regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = regexScriptsSvc.deleteRegexScript(resolvedUserId, scriptId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Dry Run (gated: "generation") ──────────────────────────────────

}
