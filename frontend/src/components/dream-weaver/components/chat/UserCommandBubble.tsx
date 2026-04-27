export function UserCommandBubble({ raw }: { raw: string }) {
  return (
    <div style={{
      alignSelf: "flex-end", maxWidth: "62%",
      padding: "9px 13px", borderRadius: "var(--lcs-radius)",
      background: "linear-gradient(225deg, rgba(255,180,100,0.04) 0%, transparent 40%), linear-gradient(145deg, rgba(255,255,255,0.022) 0%, rgba(255,255,255,0.007) 40%, rgba(255,255,255,0.013) 100%), var(--lcs-glass-bg)",
      boxShadow: "0 0 0 0.5px var(--lcs-glass-border), 0 2px 6px rgba(0,0,0,0.2)",
      fontFamily: "var(--lumiverse-font-mono)", fontSize: 12.5,
      color: "var(--lumiverse-text)",
    }}>{raw}</div>
  );
}
