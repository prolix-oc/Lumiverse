import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from 'react-i18next'

import {
  Archive, Link2, Plus, Trash2, AlertTriangle, ChevronDown,
  ChevronRight, Pencil, Check, X, Unlink, ArrowLeftRight,
} from "lucide-react";
import { ApiError } from "@/api/client";
import { useStore } from "@/store";
import ConfirmationModal from "@/components/shared/ConfirmationModal";
import { memoryCortexApi, type CortexVault, type CortexChatLink } from "@/api/memory-cortex";
import { chatsApi } from "@/api/chats";
import type { RecentChat } from "@/types/api";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import styles from "./MemoryCortexPanel.module.css";
import clsx from "clsx";

interface CortexLinksTabProps {
  activeChatId: string;
  activeChatName?: string;
}

type AddLinkStep = "idle" | "pick-type" | "pick-vault" | "pick-chat";

const L = 'memoryCortexPanel.links';

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && typeof err.body?.error === "string" && err.body.error.trim()) {
    return err.body.error;
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}

export default function CortexLinksTab({
  activeChatId, activeChatName }: CortexLinksTabProps) {
  const { t, i18n } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const addToast = useStore((s) => s.addToast);

  // ─── State ──────────────────────────────────────────────────
  const [links, setLinks] = useState<CortexChatLink[]>([]);
  const [vaults, setVaults] = useState<CortexVault[]>([]);
  // Start loading: the load effect runs after first paint, so initializing to
  // false would flash the empty state for a frame before the fetch begins.
  const [loading, setLoading] = useState(true);
  const [showVaultLibrary, setShowVaultLibrary] = useState(false);

  // Create vault form
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [vaultDesc, setVaultDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // Add link flow
  const [addLinkStep, setAddLinkStep] = useState<AddLinkStep>("idle");
  const [availableChats, setAvailableChats] = useState<Array<{ id: string; name: string; characterName?: string; updatedAt?: number }>>([]);
  const [bidirectional, setBidirectional] = useState(true);
  const [loadingChats, setLoadingChats] = useState(false);

  // Inline states
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  // ─── Data Loading ───────────────────────────────────────────

  const loadLinks = useCallback(async () => {
    if (!activeChatId) return;
    setLoading(true);
    try {
      const [linksRes, vaultsRes] = await Promise.all([
        memoryCortexApi.getChatLinks(activeChatId),
        memoryCortexApi.listVaults(),
      ]);
      setLinks(linksRes.data);
      setVaults(vaultsRes.data);
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [activeChatId]);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  // ─── Vault Creation ─────────────────────────────────────────

  const handleCreateVault = async () => {
    if (!vaultName.trim()) return;
    setCreating(true);
    try {
      const vault = await memoryCortexApi.createVault(activeChatId, vaultName.trim(), vaultDesc.trim() || undefined);
      addToast({
        type: "success",
        message: t(`${L}.vaultCreated`, { entities: vault.entityCount, relations: vault.relationCount }),
      });
      setShowCreateVault(false);
      setVaultName("");
      setVaultDesc("");
      await loadLinks();
    } catch (err: unknown) {
      addToast({ type: "error", message: getErrorMessage(err, t(`${L}.vaultCreateFailed`)) });
    } finally {
      setCreating(false);
    }
  };

  const openCreateVault = () => {
    const date = new Date().toLocaleDateString(i18n.language, { month: "short", day: "numeric", year: "numeric" });
    setVaultName(t(`${L}.defaultVaultName`, {
      chat: activeChatName || t(`${L}.unnamedChat`),
      date,
    }));
    setVaultDesc("");
    setShowCreateVault(true);
    setAddLinkStep("idle");
  };

  // ─── Link Management ────────────────────────────────────────

  const handleToggleLink = async (link: CortexChatLink) => {
    const newEnabled = !link.enabled;
    setLinks((prev) => prev.map((l) => l.id === link.id ? { ...l, enabled: newEnabled } : l));
    try {
      await memoryCortexApi.toggleLink(activeChatId, link.id, newEnabled);
    } catch {
      setLinks((prev) => prev.map((l) => l.id === link.id ? { ...l, enabled: link.enabled } : l));
      addToast({ type: "error", message: t(`${L}.toggleFailed`) });
    }
  };

  const handleRemoveLink = async (linkId: string) => {
    setDeletingId(null);
    try {
      await memoryCortexApi.removeLink(activeChatId, linkId);
      setLinks((prev) => prev.filter((l) => l.id !== linkId));
      addToast({ type: "info", message: t(`${L}.linkRemoved`) });
    } catch {
      addToast({ type: "error", message: t(`${L}.removeLinkFailed`) });
    }
  };

  // ─── Attach Link ────────────────────────────────────────────

  const handleAttachVault = async (vaultId: string) => {
    try {
      await memoryCortexApi.attachLink(activeChatId, { linkType: "vault", vaultId });
      addToast({ type: "success", message: t(`${L}.vaultLinked`) });
      setAddLinkStep("idle");
      await loadLinks();
    } catch (err) {
      addToast({ type: "error", message: getErrorMessage(err, t(`${L}.attachVaultFailed`)) });
    }
  };

  const handleAttachInterlink = async (targetChatId: string) => {
    try {
      await memoryCortexApi.attachLink(activeChatId, {
        linkType: "interlink",
        targetChatId,
        bidirectional,
      });
      addToast({
        type: "success",
        message: bidirectional ? t(`${L}.interlinkBidirectional`) : t(`${L}.interlinkCreated`),
      });
      setAddLinkStep("idle");
      await loadLinks();
    } catch (err) {
      addToast({ type: "error", message: getErrorMessage(err, t(`${L}.interlinkFailed`)) });
    }
  };

  const startPickChat = async () => {
    setAddLinkStep("pick-chat");
    setLoadingChats(true);
    try {
      const res = await chatsApi.listRecent({ limit: 50 });
      setAvailableChats(
        res.data
          .filter((chat: RecentChat) => chat.id !== activeChatId)
          .map((chat: RecentChat) => ({
            id: chat.id,
            name: chat.name || chat.character_name || t(`${L}.unnamedChat`),
            characterName: chat.character_name || undefined,
            updatedAt: chat.updated_at,
          })),
      );
    } catch {
      setAvailableChats([]);
    } finally {
      setLoadingChats(false);
    }
  };

  // ─── Vault Library Actions ──────────────────────────────────

  const handleDeleteVault = async (vaultId: string) => {
    setDeletingId(null);
    try {
      await memoryCortexApi.deleteVault(vaultId);
      setVaults((prev) => prev.filter((v) => v.id !== vaultId));
      setLinks((prev) => prev.filter((l) => l.vaultId !== vaultId));
      addToast({ type: "info", message: t(`${L}.vaultDeleted`) });
    } catch {
      addToast({ type: "error", message: t(`${L}.vaultDeleteFailed`) });
    }
  };

  const handleRenameVault = async (vaultId: string) => {
    if (!renameValue.trim()) return;
    try {
      await memoryCortexApi.renameVault(vaultId, renameValue.trim());
      setVaults((prev) => prev.map((v) => v.id === vaultId ? { ...v, name: renameValue.trim() } : v));
      setRenamingId(null);
    } catch {
      addToast({ type: "error", message: t(`${L}.vaultRenameFailed`) });
    }
  };

  const linkedVaultIds = new Set(links.filter((l) => l.linkType === "vault").map((l) => l.vaultId));
  const deletingLink = deletingId ? links.find((l) => l.id === deletingId) : undefined;
  const deletingVault = deletingId?.startsWith("vault-")
    ? vaults.find((v) => `vault-${v.id}` === deletingId)
    : undefined;

  if (loading) {
    return <div className={styles.loadingText}>{t(`${L}.loading`)}</div>;
  }

  return (
    <div className={styles.linksContainer}>
      <div className={styles.linksSection}>
        {links.length === 0 ? (
          <div className={styles.emptyList}>
            <Unlink size={20} strokeWidth={1.5} />
            <p>{t(`${L}.emptyTitle`)}</p>
            <span>{t(`${L}.emptyHint`)}</span>
          </div>
        ) : (
          <div className={styles.linksList}>
            {links.map((link) => (
              <div
                key={link.id}
                className={clsx(
                  styles.linkCard,
                  link.linkType === "vault" ? styles.linkCardVault : styles.linkCardInterlink,
                  !link.enabled && styles.linkCardDisabled,
                )}
              >
                <div className={styles.linkIcon}>
                  {link.linkType === "vault" ? <Archive size={14} /> : <Link2 size={14} />}
                </div>
                <div className={styles.linkInfo}>
                  <div className={styles.linkName}>
                    {link.linkType === "vault"
                      ? link.vaultName || t(`${L}.unnamedVault`)
                      : link.targetChatName || t(`${L}.unknownChat`)}
                  </div>
                  <div className={styles.linkMeta}>
                    {link.linkType === "vault" ? (
                      t(`${L}.entityRelationCounts`, {
                        entities: link.vaultEntityCount ?? 0,
                        relations: link.vaultRelationCount ?? 0,
                      })
                    ) : !link.targetChatExists ? (
                      <span className={styles.linkBroken}>
                        <AlertTriangle size={10} />
                        {t(`${L}.brokenLink`)}
                      </span>
                    ) : (
                      <span className={styles.linkLive}>
                        <span className={styles.pulseDot} />
                        {t(`${L}.liveConnection`)}
                      </span>
                    )}
                  </div>
                </div>
                <div className={styles.linkActions}>
                  <button
                    className={clsx(styles.linkToggle, link.enabled && styles.linkToggleOn)}
                    onClick={() => handleToggleLink(link)}
                    title={link.enabled ? t(`${L}.disable`) : t(`${L}.enable`)}
                  >
                    <div className={styles.linkToggleThumb} />
                  </button>
                  <button
                    className={styles.linkDeleteBtn}
                    onClick={() => setDeletingId(link.id)}
                    title={t(`${L}.removeLinkTitle`)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.linksActions}>
        <button className={styles.linksActionBtn} onClick={openCreateVault}>
          <Archive size={13} />
          {t(`${L}.createVault`)}
        </button>
        <button
          className={styles.linksActionBtn}
          onClick={() => { setAddLinkStep("pick-type"); setShowCreateVault(false); }}
        >
          <Plus size={13} />
          {t(`${L}.addLink`)}
        </button>
      </div>

      {showCreateVault && (
        <div className={styles.linksInlineForm}>
          <div className={styles.linksFormHeader}>
            <Archive size={13} className={styles.linksFormIcon} />
            <span>{t(`${L}.snapshotHeader`)}</span>
            <button className={styles.linksFormClose} onClick={() => setShowCreateVault(false)}>
              <X size={12} />
            </button>
          </div>
          <input
            className={styles.linksFormInput}
            value={vaultName}
            onChange={(e) => setVaultName(e.target.value)}
            placeholder={t(`${L}.vaultNamePlaceholder`)}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreateVault()}
          />
          <textarea
            className={styles.linksFormTextarea}
            value={vaultDesc}
            onChange={(e) => setVaultDesc(e.target.value)}
            placeholder={t(`${L}.vaultDescPlaceholder`)}
            rows={2}
          />
          <button
            className={styles.linksFormSubmit}
            onClick={handleCreateVault}
            disabled={!vaultName.trim() || creating}
          >
            {creating ? t(`${L}.creatingVault`) : t(`${L}.createVault`)}
          </button>
        </div>
      )}

      {addLinkStep === "pick-type" && (
        <div className={styles.linksInlineForm}>
          <div className={styles.linksFormHeader}>
            <Plus size={13} className={styles.linksFormIcon} />
            <span>{t(`${L}.chooseLinkType`)}</span>
            <button className={styles.linksFormClose} onClick={() => setAddLinkStep("idle")}>
              <X size={12} />
            </button>
          </div>
          <div className={styles.linkTypeCards}>
            <button
              className={clsx(styles.linkTypeCard, styles.linkTypeCardVault)}
              onClick={() => setAddLinkStep("pick-vault")}
            >
              <Archive size={16} />
              <div>
                <div className={styles.linkTypeCardTitle}>{t(`${L}.vaultTypeTitle`)}</div>
                <div className={styles.linkTypeCardDesc}>{t(`${L}.vaultTypeDesc`)}</div>
              </div>
            </button>
            <button
              className={clsx(styles.linkTypeCard, styles.linkTypeCardInterlink)}
              onClick={startPickChat}
            >
              <ArrowLeftRight size={16} />
              <div>
                <div className={styles.linkTypeCardTitle}>{t(`${L}.interlinkTypeTitle`)}</div>
                <div className={styles.linkTypeCardDesc}>{t(`${L}.interlinkTypeDesc`)}</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {addLinkStep === "pick-vault" && (
        <div className={styles.linksInlineForm}>
          <div className={styles.linksFormHeader}>
            <Archive size={13} className={styles.linksFormIcon} />
            <span>{t(`${L}.selectVault`)}</span>
            <button className={styles.linksFormClose} onClick={() => setAddLinkStep("idle")}>
              <X size={12} />
            </button>
          </div>
          <div className={styles.linksPickerList}>
            {vaults.filter((v) => !linkedVaultIds.has(v.id)).length === 0 ? (
              <div className={styles.linksPickerEmpty}>{t(`${L}.noVaultsAvailable`)}</div>
            ) : (
              vaults.filter((v) => !linkedVaultIds.has(v.id)).map((vault) => (
                <button
                  key={vault.id}
                  className={styles.linksPickerItem}
                  onClick={() => handleAttachVault(vault.id)}
                >
                  <div className={styles.linksPickerItemInfo}>
                    <div className={styles.linksPickerItemName}>{vault.name}</div>
                    <div className={styles.linksPickerItemMeta}>
                      {t(`${L}.vaultPickerMeta`, {
                        source: vault.sourceChatName || t(`${L}.deletedChat`),
                        entities: vault.entityCount,
                        date: formatRelativeTime(vault.createdAt),
                      })}
                    </div>
                  </div>
                  <Plus size={14} className={styles.linksPickerItemAction} />
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {addLinkStep === "pick-chat" && (
        <div className={styles.linksInlineForm}>
          <div className={styles.linksFormHeader}>
            <ArrowLeftRight size={13} className={styles.linksFormIcon} />
            <span>{t(`${L}.selectChat`)}</span>
            <button className={styles.linksFormClose} onClick={() => setAddLinkStep("idle")}>
              <X size={12} />
            </button>
          </div>
          <div className={styles.linksPickerList}>
            {loadingChats ? (
              <div className={styles.linksPickerEmpty}>{t(`${L}.loadingChats`)}</div>
            ) : availableChats.length === 0 ? (
              <div className={styles.linksPickerEmpty}>{t(`${L}.noChatsAvailable`)}</div>
            ) : (
              availableChats.map((chat) => (
                <button
                  key={chat.id}
                  className={styles.linksPickerItem}
                  onClick={() => handleAttachInterlink(chat.id)}
                >
                  <div className={styles.linksPickerItemInfo}>
                    <div className={styles.linksPickerItemName}>{chat.name}</div>
                    {chat.characterName && (
                      <div className={styles.linksPickerItemMeta}>
                        {chat.characterName}{chat.updatedAt ? ` · ${formatRelativeTime(chat.updatedAt)}` : ""}
                      </div>
                    )}
                  </div>
                  <Link2 size={14} className={styles.linksPickerItemAction} />
                </button>
              ))
            )}
          </div>
          <label className={styles.linksBidirectionalRow}>
            <input
              type="checkbox"
              checked={bidirectional}
              onChange={(e) => setBidirectional(e.target.checked)}
            />
            <span>{t(`${L}.bidirectional`)}</span>
          </label>
        </div>
      )}

      <div className={styles.linksLibrary}>
        <button
          className={styles.linksLibraryHeader}
          onClick={() => setShowVaultLibrary(!showVaultLibrary)}
        >
          {showVaultLibrary ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{t(`${L}.yourVaults`)}</span>
          {vaults.length > 0 && (
            <span className={styles.tabBadge}>{vaults.length}</span>
          )}
        </button>

        {showVaultLibrary && (
          <div className={styles.linksLibraryList}>
            {vaults.length === 0 ? (
              <div className={styles.linksPickerEmpty}>{t(`${L}.noVaultsYet`)}</div>
            ) : (
              vaults.map((vault) => (
                <div key={vault.id} className={styles.linksLibraryItem}>
                  {renamingId === vault.id ? (
                    <div className={styles.linksRenameRow}>
                      <input
                        ref={renameRef}
                        className={styles.linksFormInput}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameVault(vault.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        autoFocus
                      />
                      <button className={styles.linksRenameConfirm} onClick={() => handleRenameVault(vault.id)}>
                        <Check size={12} />
                      </button>
                      <button className={styles.linksRenameCancel} onClick={() => setRenamingId(null)}>
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className={styles.linksLibraryItemInfo}>
                        <div className={styles.linksLibraryItemName}>{vault.name}</div>
                        <div className={styles.linksLibraryItemMeta}>
                          {vault.sourceChatName ? (
                            <span>{vault.sourceChatName}</span>
                          ) : (
                            <span className={styles.linkDimText}>{t(`${L}.deletedChat`)}</span>
                          )}
                          {" · "}
                          {t(`${L}.entityRelationCounts`, {
                            entities: vault.entityCount,
                            relations: vault.relationCount,
                          })}
                          {" · "}
                          {formatRelativeTime(vault.createdAt)}
                        </div>
                      </div>
                      <div className={styles.linksLibraryItemActions}>
                        {!linkedVaultIds.has(vault.id) && (
                          <button
                            className={styles.linksLibraryBtn}
                            onClick={() => handleAttachVault(vault.id)}
                            title={t(`${L}.attachToChat`)}
                          >
                            <Plus size={12} />
                          </button>
                        )}
                        <button
                          className={styles.linksLibraryBtn}
                          onClick={() => { setRenamingId(vault.id); setRenameValue(vault.name); }}
                          title={tc('actions.edit')}
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          className={clsx(styles.linksLibraryBtn, styles.linksLibraryBtnDanger)}
                          onClick={() => setDeletingId(`vault-${vault.id}`)}
                          title={t(`${L}.deleteVaultTitle`)}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {deletingLink && (
        <ConfirmationModal
          isOpen={true}
          title={t(`${L}.removeLinkTitle`)}
          message={t(`${L}.removeConfirm`)}
          variant="danger"
          confirmText={t(`${L}.remove`)}
          onConfirm={() => { void handleRemoveLink(deletingLink.id) }}
          onCancel={() => setDeletingId(null)}
        />
      )}

      {deletingVault && (
        <ConfirmationModal
          isOpen={true}
          title={t(`${L}.deleteVaultTitle`)}
          message={t(`${L}.deleteVaultConfirm`, { name: deletingVault.name })}
          variant="danger"
          confirmText={t(`${L}.deleteVault`)}
          onConfirm={() => { void handleDeleteVault(deletingVault.id) }}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}
