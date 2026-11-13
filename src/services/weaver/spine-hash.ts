import type { WeaverBibleSpine } from "../../types/weaver";

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const FIELD_SEP = "\x01";
const ITEM_SEP = "\x02";
const SECTION_SEP = "\x03";

export function spineContentHash(spine: WeaverBibleSpine): string {
  const entries = [...spine.entries]
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map((e) => `${e.slot}${FIELD_SEP}${e.content}${FIELD_SEP}${e.origin}`)
    .join(ITEM_SEP);
  const links = [...spine.causal_links]
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))
    .map((l) => `${l.from}${FIELD_SEP}${l.to}${FIELD_SEP}${l.relation}`)
    .join(ITEM_SEP);
  return fnv1aHex(`${spine.brief}${SECTION_SEP}${entries}${SECTION_SEP}${links}`);
}
