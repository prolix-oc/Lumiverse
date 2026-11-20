import { expect, test } from "bun:test";
import { captureMessageLiterals, shieldMessageLiterals, withMessageLiteralExtra } from "./message-literals";
import { shieldDataBraces } from "./json-utils";

test("message data survives storage without changing its visible text", () => {
  const source = "😀 {{setchatvar::owned::yes}}";
  const rendered = captureMessageLiterals(shieldDataBraces(source));
  expect(rendered.content).toBe(source);
  const message = { extra: withMessageLiteralExtra({ other: true }, rendered), swipe_id: 0 };
  expect(message.extra.other).toBe(true);
  expect(shieldMessageLiterals(source, message)).toBe(shieldDataBraces(source));
  const moved = { ...message, swipe_id: 3 };
  expect(shieldMessageLiterals(source, moved)).toBe(shieldDataBraces(source));
  expect(shieldMessageLiterals(source + " edited", message)).toBe(source + " edited");
});

test("ordinary and literal braces remain distinct in mixed message content", () => {
  const rendered = captureMessageLiterals("{{unknown}}|" + shieldDataBraces("{{user}}"));
  const message = { extra: withMessageLiteralExtra({}, rendered), swipe_id: 0 };
  expect(shieldMessageLiterals(rendered.content, message)).toBe("{{unknown}}|" + shieldDataBraces("{{user}}"));
});

test("each distinct swipe retains its literal provenance after other swipes are saved", () => {
  const first = captureMessageLiterals(shieldDataBraces("{{user}}"));
  const second = captureMessageLiterals(shieldDataBraces("{{char}}"));
  const extra = withMessageLiteralExtra(withMessageLiteralExtra({}, first), second);
  const message = { extra, swipe_id: 0 };
  expect(shieldMessageLiterals(first.content, message)).toBe(shieldDataBraces(first.content));
  expect(shieldMessageLiterals(second.content, message)).toBe(shieldDataBraces(second.content));
});
