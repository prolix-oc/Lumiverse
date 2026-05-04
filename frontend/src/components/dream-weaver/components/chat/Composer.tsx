import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Globe, Send, Sparkles, Wrench } from "lucide-react";
import { parseSlash } from "../../lib/slash-parser";
import type { ToolCatalogEntry } from "@/api/dream-weaver-tooling";
import styles from "./Composer.module.css";

interface Props {
  catalog: ToolCatalogEntry[];
  hasSource: boolean;
  onSubmit: (tool: string, rawArgs: string, raw: string) => void;
}

export function Composer({ catalog, hasSource, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsId = useId();

  const userTools = useMemo(() => catalog.filter((t) => t.userInvocable), [catalog]);
  const commandState = useMemo(() => getCommandState(value), [value]);
  const suggestions = useMemo(() => {
    if (!commandState.isCommandToken) return [];
    const term = commandState.term;

    return userTools
      .map((tool) => ({ tool, score: getCommandMatchScore(tool, term) }))
      .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => {
        const commandA = getCommandText(a.tool);
        const commandB = getCommandText(b.tool);
        return a.score - b.score
          || getDefaultCommandRank(a.tool) - getDefaultCommandRank(b.tool)
          || commandA.length - commandB.length
          || a.tool.displayName.localeCompare(b.tool.displayName);
      })
      .map((entry) => entry.tool)
      .slice(0, 6);
  }, [commandState, userTools]);

  const hasCommandArgs = useMemo(() => {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("/")) return false;
    const commandEnd = trimmed.search(/\s/);
    if (commandEnd === -1) return false;
    return trimmed.slice(commandEnd).trim().length > 0;
  }, [value]);

  const showSuggestions =
    focused &&
    !menuDismissed &&
    commandState.isCommandToken &&
    commandState.term.length > 0 &&
    !hasCommandArgs &&
    suggestions.length > 0;
  const activeOptionId = showSuggestions && suggestions[activeIndex]
    ? `${suggestionsId}-option-${suggestions[activeIndex].name}`
    : undefined;

  useEffect(() => {
    setActiveIndex((idx) => Math.min(idx, Math.max(suggestions.length - 1, 0)));
  }, [suggestions.length]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  }, [value]);

  const commitTool = (tool: ToolCatalogEntry) => {
    const command = tool.slashCommand ?? `/${tool.name}`;
    setValue(`${command} `);
    setError(null);
    setMenuDismissed(false);
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = () => {
    const raw = value.trim();
    const result = parseSlash(raw, catalog);
    if (result.ok === false) {
      setError(result.error);
      return;
    }
    if (!hasSource && requiresSource(result.tool)) {
      setError("Add source material with /dream before running generation tools.");
      return;
    }
    setError(null);
    onSubmit(result.tool.name, result.rawArgs, raw);
    setValue("");
    setMenuDismissed(false);
    setActiveIndex(0);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "ArrowDown" && showSuggestions) {
      e.preventDefault();
      setActiveIndex((idx) => Math.min(idx + 1, suggestions.length - 1));
      return;
    }
    if (e.key === "ArrowUp" && showSuggestions) {
      e.preventDefault();
      setActiveIndex((idx) => Math.max(idx - 1, 0));
      return;
    }
    if (e.key === "Tab" && showSuggestions && suggestions[activeIndex]) {
      e.preventDefault();
      if (!commandState.term) return;
      commitTool(suggestions[activeIndex]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showSuggestions && !value.includes(" ") && suggestions[activeIndex]) {
        const parsed = parseSlash(value.trim(), catalog);
        if (parsed.ok) {
          submit();
          return;
        }
        commitTool(suggestions[activeIndex]);
        return;
      }
      submit();
    }
    if (e.key === "Escape") {
      setMenuDismissed(true);
    }
  };

  return (
    <div className={styles.composer}>
      {showSuggestions && (
        <div className={styles.suggestions} id={suggestionsId} role="listbox">
          <div className={styles.suggestionHeader}>
            <span>Tools</span>
            <span>Tab completes a typed command</span>
          </div>
          {suggestions.map((tool, index) => {
            const command = tool.slashCommand ?? `/${tool.name}`;
            return (
              <button
                id={`${suggestionsId}-option-${tool.name}`}
                key={tool.name}
                type="button"
                className={styles.suggestion}
                data-active={index === activeIndex || undefined}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commitTool(tool);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={styles.suggestionIcon} data-category={tool.category}>
                  {tool.name === "help" ? <ArrowUpRight size={13} /> : getCategoryIcon(tool.category)}
                </span>
                <span className={styles.suggestionMain}>
                  <span className={styles.suggestionCommand}>{command}</span>
                  <span className={styles.suggestionDescription}>{tool.description}</span>
                </span>
                <span className={styles.suggestionCategory}>{tool.category}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.inputRow}>
        <div className={styles.inputWrap} data-error={error || undefined}>
          <textarea
            ref={inputRef}
            value={value}
            onFocus={() => {
              setFocused(true);
              setMenuDismissed(false);
            }}
            onBlur={() => {
              setFocused(false);
              setMenuDismissed(false);
            }}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
              setMenuDismissed(false);
              setActiveIndex(0);
            }}
            onKeyDown={onKey}
            placeholder="/dream describe the setup, or run /name. Shift+Enter for a new line."
            className={styles.input}
            rows={1}
            aria-controls={showSuggestions ? suggestionsId : undefined}
            aria-expanded={showSuggestions}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-activedescendant={activeOptionId}
            role="combobox"
          />
        </div>
        <button
          className={styles.send}
          onMouseDown={(event) => event.preventDefault()}
          onClick={submit}
          title="Run command"
          aria-label="Run Dream Weaver command"
        >
          <Send size={14} />
        </button>
      </div>
      {error && <div className={styles.errorBanner}>{error}</div>}
    </div>
  );
}

interface CommandState {
  isCommandToken: boolean;
  term: string;
}

function getCommandState(value: string): CommandState {
  const trimmedStart = value.trimStart();
  if (!trimmedStart.startsWith("/")) return { isCommandToken: false, term: "" };
  const commandBody = trimmedStart.slice(1);
  const firstSpace = commandBody.search(/\s/);
  if (firstSpace !== -1) return { isCommandToken: false, term: commandBody.slice(0, firstSpace).toLowerCase() };
  return { isCommandToken: true, term: commandBody.toLowerCase() };
}

function getCommandText(tool: ToolCatalogEntry): string {
  return (tool.slashCommand ?? `/${tool.name}`).replace(/^\//, "").toLowerCase();
}

function getCommandMatchScore(tool: ToolCatalogEntry, term: string): number {
  if (!term) return getDefaultCommandRank(tool);

  const command = getCommandText(tool);
  const name = tool.name.toLowerCase();
  const compactName = name.replace(/_/g, "");
  const displayName = tool.displayName.toLowerCase();
  const compactDisplayName = displayName.replace(/\s+/g, "");
  const compactTerm = term.replace(/[_\s-]+/g, "");

  if (command === term || name === term || compactName === compactTerm) return 0;
  if (command.startsWith(term)) return 1;
  if (name.startsWith(term) || compactName.startsWith(compactTerm)) return 2;
  if (displayName.startsWith(term) || compactDisplayName.startsWith(compactTerm)) return 3;
  if (command.includes(term)) return 4;
  if (name.includes(term) || compactName.includes(compactTerm)) return 5;
  if (displayName.includes(term) || compactDisplayName.includes(compactTerm)) return 6;
  return Number.POSITIVE_INFINITY;
}

function getDefaultCommandRank(tool: ToolCatalogEntry): number {
  if (tool.name === "dream_source") return 0;
  if (tool.name === "help") return 1;
  return 10 + getCategoryRank(tool.category);
}

function getCategoryIcon(category: ToolCatalogEntry["category"]) {
  if (category === "soul") return <Sparkles size={13} />;
  if (category === "world") return <Globe size={13} />;
  return <Wrench size={13} />;
}

function getCategoryRank(category: ToolCatalogEntry["category"]): number {
  if (category === "lifecycle") return 0;
  if (category === "soul") return 1;
  if (category === "world") return 2;
  return 3;
}

function requiresSource(tool: ToolCatalogEntry): boolean {
  return tool.name !== "help" && tool.name !== "dream_source";
}
