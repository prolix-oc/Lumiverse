import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Send, Wrench } from "lucide-react";
import { parseSlash } from "../../lib/slash-parser";
import type { ToolCatalogEntry } from "@/api/dream-weaver-tooling";
import styles from "./Composer.module.css";

interface Props {
  catalog: ToolCatalogEntry[];
  onSubmit: (tool: string, rawArgs: string, raw: string) => void;
}

export function Composer({ catalog, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const userTools = useMemo(() => catalog.filter((t) => t.userInvocable), [catalog]);
  const suggestions = useMemo(() => {
    const query = value.trim().replace(/^\//, "").toLowerCase();
    const [commandPart] = query.split(/\s+/, 1);
    const term = commandPart || query;

    const filtered = userTools.filter((tool) => {
      if (!term) return true;
      const command = (tool.slashCommand ?? `/${tool.name}`).replace(/^\//, "").toLowerCase();
      return [
        command,
        tool.name.toLowerCase(),
        tool.displayName.toLowerCase(),
        tool.description.toLowerCase(),
        tool.category.toLowerCase(),
      ].some((text) => text.includes(term));
    });

    return filtered.sort((a, b) => {
      if (a.name === "help") return -1;
      if (b.name === "help") return 1;
      return getCategoryRank(a.category) - getCategoryRank(b.category)
        || a.displayName.localeCompare(b.displayName);
    }).slice(0, 8);
  }, [userTools, value]);

  const showSuggestions = focused && suggestions.length > 0;

  const commitTool = (tool: ToolCatalogEntry) => {
    const command = tool.slashCommand ?? `/${tool.name}`;
    setValue(`${command} `);
    setError(null);
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
    setError(null);
    onSubmit(result.tool.name, result.rawArgs, raw);
    setValue("");
    setActiveIndex(0);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
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
      commitTool(suggestions[activeIndex]);
      return;
    }
    if (e.key === "Enter") {
      if (showSuggestions && !value.includes(" ") && suggestions[activeIndex]) {
        const parsed = parseSlash(value.trim(), catalog);
        if (parsed.ok) {
          submit();
          return;
        }
        e.preventDefault();
        commitTool(suggestions[activeIndex]);
        return;
      }
      submit();
    }
    if (e.key === "Escape") {
      setFocused(false);
    }
  };

  return (
    <div className={styles.composer}>
      {showSuggestions && (
        <div className={styles.suggestions}>
          {suggestions.map((tool, index) => {
            const command = tool.slashCommand ?? `/${tool.name}`;
            return (
              <button
                key={tool.name}
                type="button"
                className={styles.suggestion}
                data-active={index === activeIndex || undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commitTool(tool);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={styles.suggestionIcon}>
                  {tool.name === "help" ? <ArrowUpRight size={13} /> : <Wrench size={13} />}
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

      <div className={styles.inputWrap} data-error={error || undefined}>
        <input
          ref={inputRef}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setActiveIndex(0);
          }}
          onKeyDown={onKey}
          placeholder="/"
          className={styles.input}
        />
      </div>
      <button className={styles.send} onMouseDown={(event) => event.preventDefault()} onClick={submit} title="Run command">
        <Send size={14} />
      </button>
      {error && <div className={styles.errorBanner}>{error}</div>}
    </div>
  );
}

function getCategoryRank(category: ToolCatalogEntry["category"]): number {
  if (category === "lifecycle") return 0;
  if (category === "soul") return 1;
  if (category === "world") return 2;
  return 3;
}
