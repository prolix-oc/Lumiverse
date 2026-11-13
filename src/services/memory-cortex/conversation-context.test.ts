import { expect, test } from "bun:test";
import { resolveConversationParticipants, type CortexParticipant } from "./conversation-context";
import { extractParticipantRelationships } from "./relationship-extractor";

const names = ["Mara", "Prolix"];
const participants: CortexParticipant[] = [{ name: "Mara", role: "character" }, { name: "Prolix", role: "user" }];

test("stored message roles give a character-only chunk its missing user identity", () => {
  expect(resolveConversationParticipants('[CHARACTER | Mara]: "I love you."', names, [], participants)).toEqual([
    { name: "Prolix", role: "user" }, { name: "Mara", role: "character" },
  ]);
  expect(resolveConversationParticipants('[USER | Prolix]: I kissed you.', names, [], participants)).toEqual([
    { name: "Mara", role: "character" }, { name: "Prolix", role: "user" },
  ]);
});

test("group and unknown-author passages do not invent a missing counterpart", () => {
  expect(resolveConversationParticipants('[USER | Prolix]: "I love you."', [...names, "Tovin"]))
    .toEqual([{ name: "Prolix", role: "user" }]);
  expect(resolveConversationParticipants('[CHARACTER | Unknown]: "I love you."', names))
    .toEqual([{ name: "Unknown", role: "character" }]);
  expect(resolveConversationParticipants('[CHARACTER | Mara]: "I love you."', names))
    .toEqual([{ name: "Mara", role: "character" }]);
});

test("clear first-person romantic signals produce candidates with exact passage evidence", () => {
  for (const text of ['"I love you."', '"I am in love with you."', '"I have a crush on you."', '"I want to date you."',
    'I kissed you.', '"You are my girlfriend."', '"Pay up, my love. Then walk me to the shop."']) {
    expect(extractParticipantRelationships(`[CHARACTER | Mara]: ${text}`, names, [], [], participants)).toEqual([
      expect.objectContaining({ source: "Mara", target: "Prolix", type: "lover", label: "romantic interest", evidence: [text] }),
    ]);
  }
});

test("candidates follow the current message owner and canonical aliases", () => {
  const passage = '[USER | Prolix]: I kissed you.\n[CHARACTER | Red]: "I want to date you."';
  expect(extractParticipantRelationships(passage, names, [{ alias: "Red", canonicalName: "Mara" }]).map(({ source, target }) => ({ source, target })))
    .toEqual([{ source: "Prolix", target: "Mara" }, { source: "Mara", target: "Prolix" }]);
});

test("decorated stored author labels retain the configured canonical identity", () => {
  const stored: CortexParticipant[] = [{ name: "Mara", role: "character", aliases: ["★ Mara | RP"] }, participants[1]!];
  expect(extractParticipantRelationships('[CHARACTER | ★ Mara | RP]: "I love you."', names, [], [], stored))
    .toEqual([expect.objectContaining({ source: "Mara", target: "Prolix", type: "lover" })]);
});

test("co-presence, hotel plans, negation, hypotheticals and third-party dialogue cannot seed romance", () => {
  for (const text of ['We shared a table.', '"I will stay in your room tonight."', '"I do not love you."',
    '"If I love you, I will tell you."', '"I love you," she said.', 'Tovin said, "I love you."',
    '"I love you," said Tovin.', 'Prolix whispered, "I love you."', '"I love you," I joked.', '"I love you," I told Tovin.']) {
    expect(extractParticipantRelationships(`[CHARACTER | Mara]: ${text}`, names, [], ["Tovin"], participants)).toEqual([]);
  }
  expect(extractParticipantRelationships('[USER | Prolix]: "I love you."', [...names, "Tovin"])).toEqual([]);
  expect(extractParticipantRelationships('"I love you."', names)).toEqual([]);
});

test("a shared author label keeps members separate and does not select a speaker or addressee", () => {
  const label = "Pulchra Fellini and Jane Doe";
  const shared: CortexParticipant[] = [
    { name: "Pulchra Fellini", role: "character", authorLabel: label },
    { name: "Jane Doe", role: "character", authorLabel: label },
    { name: "Darran", role: "user" },
  ];
  const names = shared.map((p) => p.name);
  for (const passage of [`[CHARACTER | ${label}]: I love you.`, '[USER | Darran]: I love you.']) {
    const resolved = resolveConversationParticipants(passage, names, [], shared);
    expect(resolved.map((p) => p.name).sort()).toEqual([...names].sort());
    expect(resolved.filter((p) => p.authorLabel === label)).toHaveLength(2);
    expect(extractParticipantRelationships(passage, names, [], [], shared)).toEqual([]);
  }
  const passage = `[CHARACTER | Pulchra Fellini]: I love you.`;
  expect(extractParticipantRelationships(passage, names, [], [], shared)).toEqual([
    expect.objectContaining({ source: "Pulchra Fellini", target: "Darran", type: "lover" }),
  ]);
});
