import { describe, expect, test } from "bun:test";
import {
  MAX_ARTIFACT_BYTES,
  MAX_AUDIO_BYTES,
  MAX_DATABANK_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_NOTIFICATION_SOUND_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_THEME_ASSET_BYTES,
  MAX_WALLPAPER_VIDEO_BYTES,
  mediaPolicyLimit,
  mediaDomainLimit,
  strictestMediaLimit,
} from "../../types/media-limits";
import {
  ARCHIVE_TABLE_REGISTRY,
  ARCHIVE_REGISTRY_VERSION,
  SECRET_SETTING_KEY_PATTERNS,
  getArchiveTableSpec,
  isSecretSettingKey,
} from "./table-registry";

describe("agent turn archive classification", () => {
  test("pins the current archive registry contract version", () => {
    expect(ARCHIVE_REGISTRY_VERSION).toBe(5);
  });
  test("keeps operational turn rows out and makes publication rows self-contained", () => {
    const operational = [
      "agent_turn_executions",
      "agent_turn_workspaces",
      "agent_workspace_tasks",
      "agent_workspace_records",
      "agent_workspace_submissions",
      "agent_artifact_blobs",
      "agent_artifact_blob_journal",
      "agent_workspace_artifacts",
      "agent_turn_commit_receipts",
      "agent_work_segment_recovery",
      "agent_work_segments",
      "agent_work_segment_transitions",
      "agent_work_segment_dispatches",
      "agent_work_workspace_receipts",
    ];
    for (const table of operational) {
      expect(getArchiveTableSpec(table)?.kind).toBe("operational");
    }

    const segmentRecoveryEdge = getArchiveTableSpec("agent_work_segments")?.parentEdges
      .find((edge) => edge.parentTable === "agent_work_segment_recovery");
    expect(segmentRecoveryEdge?.columns).toEqual(["user_id", "execution_id", "attempt_id", "workspace_id"]);
    expect(segmentRecoveryEdge?.parentColumns).toEqual(["user_id", "execution_id", "attempt_id", "workspace_id"]);

    const transitionSegmentEdge = getArchiveTableSpec("agent_work_segment_transitions")?.parentEdges
      .find((edge) => edge.parentTable === "agent_work_segments");
    expect(transitionSegmentEdge?.columns).toEqual(["user_id", "execution_id", "source_segment_id"]);
    expect(transitionSegmentEdge?.parentColumns).toEqual(["user_id", "execution_id", "segment_id"]);

    const dispatchSegmentEdge = getArchiveTableSpec("agent_work_segment_dispatches")?.parentEdges
      .find((edge) => edge.parentTable === "agent_work_segments");
    expect(dispatchSegmentEdge?.columns).toEqual([
      "user_id", "execution_id", "segment_id", "attempt_id", "workspace_id",
    ]);
    expect(dispatchSegmentEdge?.parentColumns).toEqual([
      "user_id", "execution_id", "segment_id", "attempt_id", "workspace_id",
    ]);

    const receipt = getArchiveTableSpec("agent_work_workspace_receipts");
    expect(receipt?.parentEdges
      .find((edge) => edge.parentTable === "agent_turn_workspaces")?.columns)
      .toEqual(["user_id", "execution_id", "workspace_id"]);
    const receiptDispatchEdge = receipt?.parentEdges
      .find((edge) => edge.parentTable === "agent_work_segment_dispatches");
    expect(receiptDispatchEdge).toMatchObject({
      columns: ["user_id", "execution_id", "segment_id", "logical_dispatch"],
      parentColumns: ["user_id", "execution_id", "segment_id", "dispatch_ordinal"],
      nullable: false,
      onMissing: "reject",
    });
    const published = getArchiveTableSpec("agent_published_workspace_artifacts");
    expect(published?.kind).toBe("canonical");
    expect(published?.primaryKey).toEqual(["published_artifact_id"]);
    expect(published?.parentEdges.map((edge) => edge.parentTable)).toEqual([
      "user",
      "chats",
      "messages",
    ]);
    expect(published?.parentEdges.some((edge) => edge.parentTable.startsWith("agent_"))).toBe(false);
    const publishedChatEdge = published?.parentEdges.find((edge) => edge.parentTable === "chats");
    const publishedMessageEdge = published?.parentEdges.find((edge) => edge.parentTable === "messages");
    expect(publishedChatEdge?.columns).toEqual(["user_id", "chat_id"]);
    expect(publishedMessageEdge?.columns).toEqual(["chat_id", "message_id"]);

    const execution = getArchiveTableSpec("agent_turn_executions");
    const targetEdge = execution?.parentEdges.find((edge) => edge.parentTable === "messages");
    expect(targetEdge?.columns).toEqual(["chat_id", "target_message_id"]);
    expect(targetEdge?.nullable).toBe(true);

    const fileRef = published?.fileRefs[0];
    expect(fileRef?.bucket).toBe("artifacts");
    expect(fileRef?.required).toBe(true);
    expect(fileRef?.bytesColumn).toBe("byte_count");
    expect(fileRef?.pathColumn).toBe("storage_path");
    expect(fileRef?.maxBytes).toBe(MAX_ARTIFACT_BYTES);
    const row = {
      user_id: "user-1",
      chat_id: "chat-1",
      storage_path: "sha256/aa/artifact.bin",
    };
    expect(fileRef?.resolve(row, "/data")).toEqual([
      "/data/agent-artifacts/user-1/sha256/aa/artifact.bin",
    ]);
    expect(fileRef?.archivePath?.(row, "/data/agent-artifacts/user-1/sha256/aa/artifact.bin")).toBe(
      "chat-1/sha256/aa/artifact.bin",
    );

    expect(ARCHIVE_TABLE_REGISTRY.filter((spec) => spec.table.startsWith("agent_")).length).toBeGreaterThanOrEqual(10);
  });

  test("allows only the lazy embedding cache to be absent from a healthy schema", () => {
    expect(
      ARCHIVE_TABLE_REGISTRY
        .filter((spec) => spec.schemaOptional)
        .map((spec) => spec.table),
    ).toEqual(["embedding_cache"]);
    for (const obsoleteTable of [
      "edit_and_send_requests",
      "generation_outbox",
      "image_processing_queue",
    ]) {
      expect(getArchiveTableSpec(obsoleteTable)).toBeUndefined();
    }
  });
});

describe("Agentic chat mode archive authority", () => {
  test("restores chat mode overrides only as inert review-required rows", () => {
    const override = getArchiveTableSpec("chat_agent_mode_overrides");
    expect(override?.kind).toBe("canonical");
    expect(override?.authorityReset).toBe("review_required");
  });
});

describe("canonical media limits", () => {
  test("keeps notification sounds below general audio and caps archive domains", () => {
    expect(mediaDomainLimit("audio")).toBe(MAX_AUDIO_BYTES);
    expect(mediaDomainLimit("notification-sounds")).toBe(MAX_NOTIFICATION_SOUND_BYTES);
    expect(MAX_NOTIFICATION_SOUND_BYTES).toBe(2 * 1024 * 1024);
    expect(strictestMediaLimit("images", MAX_WALLPAPER_VIDEO_BYTES, "image_or_video")).toBe(
      MAX_WALLPAPER_VIDEO_BYTES,
    );
    expect(strictestMediaLimit("images", MAX_IMAGE_BYTES, "image")).toBe(MAX_IMAGE_BYTES);
    expect(strictestMediaLimit("audio", MAX_NOTIFICATION_SOUND_BYTES)).toBe(MAX_NOTIFICATION_SOUND_BYTES);
    expect(strictestMediaLimit("notification-sounds", MAX_AUDIO_BYTES)).toBe(MAX_NOTIFICATION_SOUND_BYTES);
  });

  test("separates storage buckets from closed media policies and immutable caps", () => {
    const imageRefs = getArchiveTableSpec("images")?.fileRefs ?? [];
    expect(imageRefs.map((ref) => ref.mediaPolicy)).toEqual(["image", "image_or_video", "image"]);
    expect(imageRefs.map((ref) => ref.maxBytes)).toEqual([
      MAX_IMAGE_BYTES,
      MAX_WALLPAPER_VIDEO_BYTES,
      MAX_THUMBNAIL_BYTES,
    ]);
    expect(imageRefs.every((ref) => Object.isFrozen(ref))).toBe(true);

    expect(getArchiveTableSpec("characters")?.fileRefs[0]?.mediaPolicy).toBe("image");
    expect(getArchiveTableSpec("personas")?.fileRefs[0]?.mediaPolicy).toBe("image");
    expect(getArchiveTableSpec("theme_assets")?.fileRefs[0]?.mediaPolicy).toBe("theme_asset");
    expect(getArchiveTableSpec("databank_documents")?.fileRefs[0]?.mediaPolicy).toBe("databank_document");
    expect(getArchiveTableSpec("audio_files")?.fileRefs[0]?.mediaPolicy).toBe("audio");
    expect(getArchiveTableSpec("agent_published_workspace_artifacts")?.fileRefs[0]?.mediaPolicy).toBe("artifact");

    expect(mediaPolicyLimit("image")).toBe(MAX_IMAGE_BYTES);
    expect(mediaPolicyLimit("image_or_video")).toBe(MAX_WALLPAPER_VIDEO_BYTES);
    expect(mediaPolicyLimit("notification_audio")).toBe(MAX_NOTIFICATION_SOUND_BYTES);
    expect(mediaPolicyLimit("databank_document")).toBe(MAX_DATABANK_DOCUMENT_BYTES);
    expect(MAX_IMAGE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_WALLPAPER_VIDEO_BYTES).toBe(250 * 1024 * 1024);
    expect(MAX_AUDIO_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_NOTIFICATION_SOUND_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_DATABANK_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_ARTIFACT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_THEME_ASSET_BYTES).toBe(50 * 1024 * 1024);
  });
});

/**
 * Every entry mirrors a real credential producer. `id` stands in for the
 * owning row's UUID so the connection/server-scoped forms are covered.
 */
const SECRET_SETTING_KEYS = [
  "connection_2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab_api_key",
  "image_gen_connection_2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab_api_key",
  "tts_connection_2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab_api_key",
  "stt_connection_2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab_api_key",
  "mcp_server_2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab_headers",
  "mcp_server_2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab_env",
  "embedding_api_key",
  "embedding_api_key_openai",
  "embedding_api_key_google",
  "web_search_api_key",
  "huggingface_api_token",
  "pollinations_app_key",
  "vector_store_secret_qdrant_api_key",
  "vector_store_secret_milvus_password",
  "dropbox_app_key",
  "dropbox_refresh_token",
  "dropbox_access_token",
  "dropbox_access_token_expiry",
  "google_drive_client_id",
  "google_drive_client_secret",
  "google_drive_refresh_token",
  "google_drive_access_token",
  "google_drive_access_token_expiry",
];

/** Real setting keys the product writes, including near-miss credential names. */
const BENIGN_SETTING_KEYS = [
  "activeLoomPresetId",
  "activeChatId",
  "activeProfileId",
  "builtinDefaultPresetSeedVersion",
  "chatMemorySettings",
  "council_settings",
  "databankSettings",
  "databaseMaintenance",
  "databaseTuning",
  "diskWarningSettings",
  "dnsSettings",
  "docker_st_migration_status",
  "embeddingConfig",
  "expressionDetection",
  "globalDatabanks",
  "globalWorldBooks",
  "imageGeneration",
  "loomPromptStash",
  "memoryCortexConfig",
  "presetProfile:connection:2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab",
  "presetProfileVariables:chat:2f1c1f6e-1f37-4d0b-9a3f-2c0a0c4f10ab",
  "reasoningSettings",
  "savedThemes",
  "sharpSettings",
  "sidecarSettings",
  "spindleSettings",
  "theme",
  "trustedHosts",
  "vectorStoreConfig",
  "wallpaper",
  "webSearchSettings",
  "worldBookVectorSettings",
  "worldBookVectorVersion",
  "worldInfoSettings",
  // Near-miss names that describe credentials without carrying one.
  "connection_api_key_help",
  "embedding_api_keys_enabled",
  "web_search_api_key_status",
  "pollinations_app_key_hint",
  "mcp_server_headers_help",
  "dropbox_folder",
  "google_drive_folder",
];

describe("secret setting key classification", () => {
  test.each(SECRET_SETTING_KEYS)("classifies %s as a credential setting key", (key) => {
    expect(isSecretSettingKey(key)).toBe(true);
  });

  test.each(BENIGN_SETTING_KEYS)("keeps %s exportable", (key) => {
    expect(isSecretSettingKey(key)).toBe(false);
  });

  test("rejects empty and non-string keys without throwing", () => {
    expect(isSecretSettingKey("")).toBe(false);
    expect(isSecretSettingKey(undefined as unknown as string)).toBe(false);
    expect(isSecretSettingKey(null as unknown as string)).toBe(false);
  });

  test("uses anchored stateless patterns so repeated tests agree", () => {
    for (const pattern of SECRET_SETTING_KEY_PATTERNS) {
      expect(pattern.global).toBe(false);
      expect(pattern.source.startsWith("^")).toBe(true);
      expect(pattern.source.endsWith("$")).toBe(true);
    }
    for (const key of SECRET_SETTING_KEYS) {
      expect(isSecretSettingKey(key)).toBe(isSecretSettingKey(key));
      expect(isSecretSettingKey(`prefix_${key}`)).toBe(false);
    }
  });

  test("partitions an export settings snapshot away from the secret index", () => {
    const snapshot = [...BENIGN_SETTING_KEYS, ...SECRET_SETTING_KEYS];
    const exported = snapshot.filter((key) => !isSecretSettingKey(key));
    const withheld = snapshot.filter((key) => isSecretSettingKey(key));
    expect(exported).toEqual([...BENIGN_SETTING_KEYS]);
    expect(withheld).toEqual([...SECRET_SETTING_KEYS]);
    // Every key the archive's secret index can carry must also be withheld
    // from the settings table, so a credential cannot ride along in plaintext.
    for (const key of SECRET_SETTING_KEYS) {
      expect(exported).not.toContain(key);
    }
  });
});
