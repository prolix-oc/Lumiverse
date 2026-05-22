import { Sparkles, X } from "lucide-react";
import { Spinner } from "@/components/shared/Spinner";
import type { DreamWeaverSession } from "@/api/dream-weaver";
import type { useSuiteRunner } from "../hooks/useSuiteRunner";
import styles from "./SuiteRunner.module.css";

type SuiteRunnerState = ReturnType<typeof useSuiteRunner>;

interface Props {
  suite: SuiteRunnerState;
  workspaceKind: DreamWeaverSession["workspace_kind"];
  onDismiss: () => void;
}

const SUITE_DESCRIPTIONS: Record<"character" | "scenario", string> = {
  character:
    "Runs name, appearance, personality, scenario, first message, and voice in sequence — or run tools individually below.",
  scenario:
    "Runs title, premise, main character (appearance/personality/voice), opening scene, then batches a supporting cast and lorebook entries — or run tools individually below.",
};

export function SuiteRunner({ suite, workspaceKind, onDismiss }: Props) {
  const description = SUITE_DESCRIPTIONS[workspaceKind === "scenario" ? "scenario" : "character"];
  if (suite.state === "idle") {
    return (
      <div className={styles.banner}>
        <div className={styles.bannerBody}>
          <span className={styles.bannerIcon} aria-hidden>
            <Sparkles size={13} />
          </span>
          <div className={styles.bannerText}>
            <span className={styles.bannerTitle}>Generate everything at once?</span>
            <span className={styles.bannerDesc}>
              {description}
            </span>
          </div>
        </div>
        <div className={styles.bannerActions}>
          <button className={styles.runBtn} onClick={() => void suite.start()}>
            Run Full Suite
          </button>
          <button className={styles.dismissBtn} onClick={onDismiss} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  if (suite.state === "running") {
    return (
      <div className={styles.banner} data-running role="status" aria-live="polite">
        <Spinner size={14} />
        <span className={styles.runningText}>
          Running full suite…
        </span>
      </div>
    );
  }

  if (suite.state === "done") {
    return (
      <div className={styles.banner} data-done role="status" aria-live="polite">
        <span className={styles.doneText}>
          {suite.queued || suite.total} tools ready — review results below, then accept what you like.
        </span>
        <button className={styles.dismissBtn} onClick={onDismiss} aria-label="Dismiss">
          <X size={13} />
        </button>
      </div>
    );
  }

  if (suite.state === "error") {
    return (
      <div className={styles.banner} data-error role="alert">
        <span className={styles.errorText}>Suite failed: {suite.errorMessage}</span>
        <button className={styles.runBtn} onClick={() => void suite.start()}>Retry</button>
        <button className={styles.dismissBtn} onClick={onDismiss} aria-label="Dismiss">
          <X size={13} />
        </button>
      </div>
    );
  }

  return null;
}
