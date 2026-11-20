import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { boundedAndroidPayload, FCMProvider } from "./fcm.service";

test("bounds JSON byte size, normalizes sender names, and rejects unsafe chat identifiers", () => {
  const payload = boundedAndroidPayload({ title: "🦊".repeat(500), body: "\u0001".repeat(1000), tag: "\u0001".repeat(1000),
    data: { characterName: "<b>Alice</b>", chatId: "../unsafe".repeat(10000) } });
  expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(2400);
  expect(JSON.parse(payload).data.chatId).toBeUndefined();
  expect(JSON.parse(boundedAndroidPayload({ title: "Reply", body: "text", data: { characterName: "<b>Alice</b>", url: "/chat/chat-1" } })).data)
    .toMatchObject({ characterName: "Alice", chatId: "chat-1" });
});

const simulation = process.env.LUMIVERSE_FCM_SIM_URL;
test.skipIf(!simulation)("the real FCM HTTP client handles acceptance, revoked tokens and provider failures", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = new FCMProvider({ projectId: "simulation-project", email: "simulation@simulation-project.iam.gserviceaccount.com", privateKey },
    { oauth: `${simulation}/token`, send: simulation! });
  const data = { payload: boundedAndroidPayload({ title: "Alice", body: "Your reply is ready." }),
    destinationId: "destination", serverOrigin: "https://chat.example", serverInstanceId: "server" };
  expect(await provider.send("valid-token", data)).toEqual({ sent: true });
  expect(await provider.send("unregistered", data)).toMatchObject({ sent: false, invalidToken: true });
  expect(await provider.send("unavailable", data)).toMatchObject({ sent: false });
  expect((await provider.send("unavailable", data)).invalidToken).toBeFalsy();
  expect((await provider.send("bad-project", data)).invalidToken).toBeFalsy();
  const preparing = new FCMProvider({ projectId: "simulation-project", email: "simulation@simulation-project.iam.gserviceaccount.com", privateKey },
    { oauth: `${simulation}/token`, send: simulation! });
  let away = true;
  const pending = preparing.send("valid-token", data, () => away);
  away = false;
  expect(await pending).toEqual({ sent: false });
});
