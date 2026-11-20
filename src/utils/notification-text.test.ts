import { describe, expect, test } from "bun:test";
import {
  normalizePushNotificationPayload,
  notificationPlainText,
} from "./notification-text";

describe("notificationPlainText", () => {
  test("removes formatting tags while retaining readable block boundaries", () => {
    expect(notificationPlainText(
      '<font color="red">Hello&nbsp;<b>Alice</b></font><div>Line <em>two</em><br>Next</div>',
      500,
    )).toBe("Hello Alice\nLine two\nNext");
  });

  test("drops non-visible active content", () => {
    expect(notificationPlainText(
      "Safe<script>alert('no')</script><style>.x { color: red }</style><div>Visible</div>",
      500,
    )).toBe("Safe\nVisible");
  });

  test("preserves ordinary angle brackets and decodes entities", () => {
    expect(notificationPlainText("2 < 3 &amp;&amp; 5 > 4", 500)).toBe("2 < 3 && 5 > 4");
  });

  test("truncates by Unicode character rather than UTF-16 code unit", () => {
    expect(notificationPlainText("😀😀😀", 3)).toBe("😀😀😀");
    expect(notificationPlainText("😀😀😀", 2)).toBe("😀…");
  });
});

test("normalizes only visible notification text", () => {
  expect(normalizePushNotificationPayload({
    title: "<div></div>",
    body: "<font>Ready</font>",
    image: "/api/v1/image-gen/results/image-1",
    data: { url: "/chat/chat-1" },
  })).toEqual({
    title: "Lumiverse",
    body: "Ready",
    image: "/api/v1/image-gen/results/image-1",
    data: { url: "/chat/chat-1" },
  });
});
