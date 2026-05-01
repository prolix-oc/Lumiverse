export function DreamSummary({
  title = "Dream",
  dreamText,
  tone,
  dislikes,
}: {
  title?: string;
  dreamText: string;
  tone: string | null;
  dislikes: string | null;
}) {
  return (
    <div style={{
      alignSelf: "flex-start", maxWidth: "min(720px, 78%)",
      borderRadius: "var(--lcs-radius)", padding: "10px 14px",
      background: "linear-gradient(145deg, rgba(147,112,219,0.05) 0%, transparent 50%), var(--lcs-glass-bg)",
      boxShadow: "0 0 0 0.5px var(--lcs-glass-border)",
      border: "1px dashed var(--lumiverse-primary-020)",
      color: "var(--lumiverse-text-muted)", fontSize: 12.5,
    }}>
      <div style={{ color: "var(--lumiverse-primary-text)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4, fontWeight: 700 }}>{title}</div>
      <div style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{dreamText}</div>
      {(tone || dislikes) && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--lumiverse-text-dim)" }}>
          {tone && <span><b>Tone:</b> {tone}</span>}{tone && dislikes && " · "}
          {dislikes && <span><b>Avoid:</b> {dislikes}</span>}
        </div>
      )}
    </div>
  );
}
