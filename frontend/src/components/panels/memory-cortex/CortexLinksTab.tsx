import { useState, useEffect, useCallback, useRef } from "react";
import {
  Archive, Link2, Plus, Trash2, AlertTriangle, ChevronDown,
  ChevronRight, Pencil, Check, X, Unlink, ArrowLeftRight,
} from "lucide-react";
import { useStore } from "@/store";
import { memoryCortexApi, type CortexVault, type CortexChatLink } from "@/api/memory-cortex";
import { chatsApi } from "@/api/chats";
import styles from "./MemoryCortexPanel.module.css";
import clsx from "clsx";

interface CortexLinksTabProps {
  activeChatId: string;
  activeChatName?: string;
}

type AddLinkStep = "idle" | "pick-type" | "pick-vault" | "pick-chat";

export default function CortexLinksTab({ activeChatId, activeChatName }: CortexLinksTabProps) {
  const addToast = useStore((s) => s.addToast);

  // ─── State ──────────────────────────────────────────────────
  const [links, setLinks] = useState<CortexChatLink[]>([]);
  const [vaults, setVaults] = useState<CortexVault[]>([]);
  const [loading, setLoading] = useState(false);
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
        message: `Vault created — captured ${vault.entityCount} entities, ${vault.relationCount} relations`,
      });
      setShowCreateVault(false);
      setVaultName("");
      setVaultDesc("");
      await loadLinks();
    } catch (err: any) {
      addToast({ type: "error", message: err.message || "Failed to create vault" });
    } finally {
      setCreating(false);
    }
  };

  const openCreateVault = () => {
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    setVaultName(`${activeChatName || "Chat"} — ${date}`);
    setVaultDesc("");
    setShowCreateVault(true);
    setAddLinkStep("idle");
  };

  // ─── Link Management ────────────────────────────────────────

  const handleToggleLink = async (link: CortexChatLink) => {
    const newEnabled = !link.enabled;
    // Optimistic update
    setLinks((prev) => prev.map((l) => l.id === link.id ? { ...l, enabled: newEnabled } : l));
    try {
      await memoryCortexApi.toggleLink(activeChatId, link.id, newEnabled);
    } catch {
      // Revert
      setLinks((prev) => prev.map((l) => l.id === link.id ? { ...l, enabled: link.enabled } : l));
      addToast({ type: "error", message: "Failed to toggle link" });
    }
  };

  const handleRemoveLink = async (linkId: string) => {
    try {
      await memoryCortexApi.removeLink(activeChatId, linkId);
      setLinks((prev) => prev.filter((l) => l.id !== linkId));
      setDeletingId(null);
      addToast({ type: "info", message: "Link removed" });
    } catch {
      addToast({ type: "error", message: "Failed to remove link" });
    }
  };

  // ─── Attach Link ────────────────────────────────────────────

  const handleAttachVault = async (vaultId: string) => {
    try {
      await memoryCortexApi.attachLink(activeChatId, { linkType: "vault", vaultId });
      addToast({ type: "success", message: "Vault linked to this chat" });
      setAddLinkStep("idle");
      await loadLinks();
    } catch (err: any) {
      addToast({ type: "error", message: err.message || "Failed to attach vault" });
    }
  };

  const handleAttachInterlink = async (targetChatId: string) => {
    try {
      await memoryCortexApi.attachLink(activeChatId, {
        linkType: "interlink",
        targetChatId,
        bidirectional,
      });
      addToast({ type: "success", message: bidirectional ? "Chats interlinked (bidirectional)" : "Interlink created" });
      setAddLinkStep("idle");
      await loadLinks();
    } catch (err: any) {
      addToast({ type: "error", message: err.message || "Failed to create interlink" });
    }
  };

  const startPickChat = async () => {
    setAddLinkStep("pick-chat");
    setLoadingChats(true);
    try {
      const res = await chatsApi.listRecent({ limit: 50 });
      setAvailableChats(
        res.data
          .filter((c: any) => c.chatId !== activeChatId)
          .map((c: any) => ({
            id: c.chatId,
            name: c.chatName || c.characterName || "Unnamed chat",
            characterName: c.characterName,
            updatedAt: c.lastMessageAt,
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
    try {
      await memoryCortexApi.deleteVault(vaultId);
      setVaults((prev) => prev.filter((v) => v.id !== vaultId));
      setLinks((prev) => prev.filter((l) => l.vaultId !== vaultId));
      setDeletingId(null);
      addToast({ type: "info", message: "Vault deleted" });
    } catch {
      addToast({ type: "error", message: "Failed to delete vault" });
    }
  };

  const handleRenameVault = async (vaultId: string) => {
    if (!renameValue.trim()) return;
    try {
      await memoryCortexApi.renameVault(vaultId, renameValue.trim());
      setVaults((prev) => prev.map((v) => v.id === vaultId ? { ...v, name: renameValue.trim() } : v));
      setRenamingId(null);
    } catch {
      addToast({ type: "error", message: "Failed to rename vault" });
    }
  };

  // ─── Helpers ────────────────────────────────────────────────

  const relativeDate = (ts: number) => {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const linkedVaultIds = new Set(links.filter((l) => l.linkType === "vault").map((l) => l.vaultId));

  // ─── Render ─────────────────────────────────────────────────

  if (loading) {
    return <div className={styles.loadingText}>Loading links...</div>;
  }

  return (
    <div className={styles.linksContainer}>
      {/* ── Active Links ────────────────────────────────────────── */}
      <div className={styles.linksSection}>
        {links.length === 0 ? (
          <div className={styles.emptyList}>
            <Unlink size={20} strokeWidth={1.5} />
            <p>No linked memories yet</p>
            <span>Vault or interlink another chat's memories to share context across conversations</span>
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
                {deletingId === link.id ? (
                  <div className={styles.linkConfirm}>
                    <span>Remove this link?</span>
                    <div className={styles.linkConfirmActions}>
                      <button className={styles.linkConfirmYes} onClick={() => handleRemoveLink(link.id)}>Remove</button>
                      <button className={styles.linkConfirmNo} onClick={() => setDeletingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.linkIcon}>
                      {link.linkType === "vault" ? <Archive size={14} /> : <Link2 size={14} />}
                    </div>
                    <div className={styles.linkInfo}>
                      <div className={styles.linkName}>
                        {link.linkType === "vault"
                          ? link.vaultName || "Unnamed vault"
                          : link.targetChatName || "Unknown chat"}
                      </div>
                      <div className={styles.linkMeta}>
                        {link.linkType === "vault" ? (
                          <>{link.vaultEntityCount ?? 0} entities, {link.vaultRelationCount ?? 0} relations</>
                        ) : !link.targetChatExists ? (
                          <span className={styles.linkBroken}>
                            <AlertTriangle size={10} />
                            Broken link — chat deleted
                          </span>
                        ) : (
                          <span className={styles.linkLive}>
                            <span className={styles.pulseDot} />
                            Live connection
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={styles.linkActions}>
                      <button
                        className={clsx(styles.linkToggle, link.enabled && styles.linkToggleOn)}
                        onClick={() => handleToggleLink(link)}
                        title={link.enabled ? "Disable" : "Enable"}
                      >
                        <div className={styles.linkToggleThumb} />
                      </button>
                      <button
                        className={styles.linkDeleteBtn}
                        onClick={() => setDeletingId(link.id)}
                        title="Remove link"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Actions ─────────────────────────────────────────────── */}
      <div className={styles.linksActions}>
        <button className={styles.linksActionBtn} onClick={openCreateVault}>
          <Archive size={13} />
          Create Vault
        </button>
        <button
          className={styles.linksActionBtn}
          onClick={() => { setAddLinkStep("pick-type"); setShowCreateVault(false); }}
        >
          <Plus size={13} />
          Add Link
        </button>
      </div>

      {/* ── Create Vault Form ───────────────────────────────────── */}
      {showCreateVault && (
        <div className={styles.linksInlineForm}>
          <div className={styles.linksFormHeader}>
            <Archive size={13} className={styles.linksFormIcon} />
            <span>Snapshot current cortex</span>
            <button className={styles.linksFormClose} onClick={() => setShowCreateVault(false)}>
              <X size={12} />
            </button>
          </div>
          <input
            className={styles.linksFormInput}
            value={vaultName}
            onChange={(e) => setVaultName(e.target.value)}
            placeholder="Vault name..."
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreateVault()}
          />
          <textarea
            className={styles.linksFormTextarea}
            value={vaultDesc}
            onChange={(e) => setVaultDesc(e.target.value)}
            placeholder="Description (optional)..."
            rows={2}
          />
          <button
            className={styles.linksFormSubmit}
            onClick={handleCreateVault}
            disabled={!vaultName.trim() || creating}
          >
            {creating ? "Creating..." : "Create Vault"}
          </button>
        </div>
      )}

      {/* ── Add Link Flow ───────────────────────────────────────── */}
      {addLinkStep === "pick-type" && (
        <div className={styles.linksInlineForm}>
          <div className={styles.linksFormHeader}>
            <Plus size={13} className={styles.linksFormIcon} />
            <span>Choose link type</span>
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
                <div className={styles.linkTypeCardTitle}>Vault</div>
                <div className={styles.linkTypeCardDesc}>Attach a frozen snapshot — read-only</div>
              </div>
            </button>
            <button
              className={clsx(styles.linkTypeCard, styles.linkTypeCardInterlink)}
              onClick={startPickChat}
            >
              <ArrowLeftRight size={16} />
              <div>
                <div className={styles.linkTypeCardTitle}>Interlink</div>
                <div className={styles.linkTypeCardDesc}>Live memory sharing — read/write</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {addLinkStep === "pick-vault" && (
        <div className={styles.linksInlineForm}>
          <div className={styles.linksFormHeader}>
            <Archive size={13} className={styles.linksFormIcon} />
            <span>Select a vault</span>
            <button className={styles.linksFormClose} onClick={() => setAddLinkStep("idle")}>
              <X size={12} />
            </button>
          </div>
          <div className={styles.linksPickerList}>
            {vaults.filter((v) => !linkedVaultIds.has(v.id)).length === 0 ? (
              <div className={styles.linksPickerEmpty}>No available vaults. Create one first.</div>
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
                      {vault.sourceChatName || "Deleted chat"} · {vault.entityCount} entities · {relativeDate(vault.createdAt)}
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
            <span>Select a chat to interlink</span>
            <button className={styles.linksFormClose} onClick={() => setAddLinkStep("idle")}>
              <X size={12} />
            </button>
          </div>
          <div className={styles.linksPickerList}>
            {loadingChats ? (
              <div className={styles.linksPickerEmpty}>Loading chats...</div>
            ) : availableChats.length === 0 ? (
              <div className={styles.linksPickerEmpty}>No other chats available</div>
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
                        {chat.characterName}{chat.updatedAt ? ` · ${relativeDate(chat.updatedAt)}` : ""}
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
            <span>Bidirectional — both chats share memories</span>
          </label>
        </div>
      )}

      {/* ── Vault Library ───────────────────────────────────────── */}
      <div className={styles.linksLibrary}>
        <button
          className={styles.linksLibraryHeader}
          onClick={() => setShowVaultLibrary(!showVaultLibrary)}
        >
          {showVaultLibrary ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>Your Vaults</span>
          {vaults.length > 0 && (
            <span className={styles.tabBadge}>{vaults.length}</span>
          )}
        </button>

        {showVaultLibrary && (
          <div className={styles.linksLibraryList}>
            {vaults.length === 0 ? (
              <div className={styles.linksPickerEmpty}>No vaults yet</div>
            ) : (
              vaults.map((vault) => (
                <div key={vault.id} className={styles.linksLibraryItem}>
                  {deletingId === `vault-${vault.id}` ? (
                    <div className={styles.linkConfirm}>
                      <span>Delete vault "{vault.name}"?</span>
                      <div className={styles.linkConfirmActions}>
                        <button className={styles.linkConfirmYes} onClick={() => handleDeleteVault(vault.id)}>Delete</button>
                        <button className={styles.linkConfirmNo} onClick={() => setDeletingId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : renamingId === vault.id ? (
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
                            <span className={styles.linkDimText}>Deleted chat</span>
                          )}
                          {" · "}
                          {vault.entityCount} entities, {vault.relationCount} relations
                          {" · "}
                          {relativeDate(vault.createdAt)}
                        </div>
                      </div>
                      <div className={styles.linksLibraryItemActions}>
                        {!linkedVaultIds.has(vault.id) && (
                          <button
                            className={styles.linksLibraryBtn}
                            onClick={() => handleAttachVault(vault.id)}
                            title="Attach to current chat"
                          >
                            <Plus size={12} />
                          </button>
                        )}
                        <button
                          className={styles.linksLibraryBtn}
                          onClick={() => { setRenamingId(vault.id); setRenameValue(vault.name); }}
                          title="Rename"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          className={clsx(styles.linksLibraryBtn, styles.linksLibraryBtnDanger)}
                          onClick={() => setDeletingId(`vault-${vault.id}`)}
                          title="Delete vault"
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
    </div>
  );
}
