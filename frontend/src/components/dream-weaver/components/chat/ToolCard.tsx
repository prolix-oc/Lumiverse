import { useState } from "react";
import { ChevronDown, Clock3, Hash, Loader2, Wrench } from "lucide-react";
import type { DreamWeaverMessage, DreamWeaverToolTokenUsage } from "@/api/dream-weaver-tooling";
import { ToolCardActions } from "./ToolCardActions";
import { NudgeInline } from "./NudgeInline";
import styles from "./ToolCard.module.css";

interface Props {
  message: DreamWeaverMessage;
  isLatestInChain: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (msg: DreamWeaverMessage, nudge: string | null) => void;
}

export function ToolCard({ message, isLatestInChain, onAccept, onReject, onCancel, onRetry }: Props) {
  const payload = message.payload as {
    tool: string;
    output: any;
    error: { message?: string } | null;
    duration_ms: number | null;
    token_usage?: DreamWeaverToolTokenUsage | null;
  };
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const status = message.status ?? "running";
  const running = status === "running";

  return (
    <div className={styles.run} data-status={status}>
      <div className={styles.content}>
        <div className={styles.head}>
          <div className={styles.identity}>
            <span className={styles.toolIcon}>
              {running ? <Loader2 size={13} /> : <Wrench size={13} />}
            </span>
            <div>
              <div className={styles.name}>{formatToolName(payload.tool)}</div>
              <div className={styles.intent}>{getToolIntent(payload.tool)}</div>
            </div>
          </div>
          <div className={styles.metaGroup}>
            <span className={styles.status} data-s={status}>{formatStatus(status)}</span>
            <TokenUsage usage={payload.token_usage} />
            <span className={styles.metaItem} title="Run time">
              <Clock3 size={12} />
              {payload.duration_ms ? `${(payload.duration_ms / 1000).toFixed(1)}s` : "…"}
            </span>
          </div>
        </div>

        {running ? (
          <div className={styles.runningRows}>
            <div className={styles.skel} />
            <div className={styles.skel} />
            <div className={styles.skel} />
          </div>
        ) : payload.error ? (
          <div className={styles.errorBox}>
            <span className={styles.errorLabel}>Tool Error</span>
            <p>{getToolErrorMessage(payload.error.message)}</p>
          </div>
        ) : (
          <ToolOutput output={payload.output} />
        )}

        {isLatestInChain && status === "pending" && (
          <ToolCardActions
            hasError={!!payload.error}
            onAccept={() => onAccept(message.id)}
            onReject={() => onReject(message.id)}
            onRetry={() => onRetry(message, null)}
            onNudge={() => setNudgeOpen(true)}
          />
        )}
        {isLatestInChain && status === "running" && (
          <div className={styles.cancelRow}>
            <button onClick={() => onCancel(message.id)} className={styles.cancelBtn}>Cancel run</button>
          </div>
        )}
        {nudgeOpen && (
          <NudgeInline
            onCancel={() => setNudgeOpen(false)}
            onSubmit={(text) => { setNudgeOpen(false); onRetry(message, text); }}
          />
        )}
        {!running && !payload.error && (
          <details className={styles.runDetails}>
            <summary>
              <ChevronDown size={13} />
              Run details
            </summary>
            <pre className={styles.rawOutput}>{JSON.stringify(payload.output, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function getToolErrorMessage(message: string | undefined): string {
  if (!message) return "Tool execution failed. Check the connection and try again.";
  if (
    message.startsWith("Choose a ") ||
    message.startsWith("Add source material") ||
    message === "Generation was canceled." ||
    message === "Unknown Dream Weaver tool." ||
    message === "The tool could not finish. Check the connection and try again."
  ) {
    return message;
  }
  return "Tool execution failed. Check the connection and try again.";
}

function formatToolName(tool: string): string {
  return tool.replace(/^set_/, "").replace(/^add_/, "add ").replace(/_/g, " ");
}

function getToolIntent(tool: string): string {
  switch (tool) {
    case "set_name": return "Identity";
    case "set_appearance": return "Visual profile";
    case "set_personality": return "Behavior";
    case "set_scenario": return "Situation";
    case "set_voice_guidance": return "Voice";
    case "set_first_message": return "Opening message";
    case "set_greeting": return "Alternate start";
    case "add_lorebook_entry": return "World memory";
    case "add_npc": return "World cast";
    default: return "Tool result";
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case "accepted": return "Applied";
    case "pending": return "Ready to Review";
    case "running": return "Running";
    case "rejected": return "Discarded";
    case "superseded": return "Replaced";
    default: return status;
  }
}

function TokenUsage({ usage }: { usage?: DreamWeaverToolTokenUsage | null }) {
  if (!usage) return null;
  return (
    <span className={styles.metaItem} title={`${usage.tokenizer_name} · ${usage.model}`}>
      <Hash size={12} />
      {formatCount(usage.input_tokens)} in
      <span className={styles.metaDot} />
      {formatCount(usage.output_tokens)} out
      <span className={styles.metaTotal}>{formatCount(usage.total_tokens)}</span>
    </span>
  );
}

function formatCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function ToolOutput({ output }: { output: any }) {
  const entries = buildOutputEntries(output);
  return (
    <div className={styles.outputPanel}>
      {entries.map((entry) => (
        <OutputField key={entry.label} label={entry.label} value={entry.value} />
      ))}
      {renderAppearanceData(output?.appearance_data)}
      {renderVoiceRules(output?.voice_guidance)}
    </div>
  );
}

function buildOutputEntries(output: any): Array<{ label: string; value: unknown }> {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return [{ label: "Result", value: output }];
  }

  const skip = new Set(["appearance_data", "voice_guidance"]);
  return Object.entries(output)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => ({ label: humanizeKey(key), value }));
}

function humanizeKey(key: string): string {
  if (key === "first_mes") return "First Message";
  return key.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function OutputField({ label, value }: { label: string; value: unknown }) {
  const text = stringifyValue(value);
  const long = text.length > 360;

  return (
    <section className={styles.field}>
      <div className={styles.fieldLabel}>{label}</div>
      <div className={styles.fieldText} data-long={long || undefined}>
        {long ? `${text.slice(0, 360).trimEnd()}…` : text}
      </div>
      {long && (
        <details className={styles.moreDetails}>
          <summary>Show full {label.toLowerCase()}</summary>
          <div className={styles.fullText}>{text}</div>
        </details>
      )}
    </section>
  );
}

function stringifyValue(value: unknown): string {
  if (value == null) return "Not provided";
  if (Array.isArray(value)) return value.map((item) => stringifyValue(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function renderAppearanceData(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([, v]) => v != null && String(v).trim());
  if (entries.length === 0) return null;
  return (
    <section className={styles.field}>
      <div className={styles.fieldLabel}>Appearance Data</div>
      <div className={styles.chipGrid}>
        {entries.slice(0, 16).map(([key, v]) => (
          <span key={key} className={styles.dataChip}>
            <span>{humanizeKey(key)}</span>
            {String(v)}
          </span>
        ))}
      </div>
    </section>
  );
}

function renderVoiceRules(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const voice = value as any;
  const rules = voice.rules && typeof voice.rules === "object" ? voice.rules : null;
  if (!rules) return null;
  return (
    <section className={styles.field}>
      <div className={styles.fieldLabel}>Voice Rules</div>
      <div className={styles.ruleGrid}>
        {Object.entries(rules).map(([key, items]) => (
          <div key={key} className={styles.ruleGroup}>
            <span>{humanizeKey(key)}</span>
            <p>{Array.isArray(items) && items.length > 0 ? items.join("; ") : "None"}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
