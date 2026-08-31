import { describe, expect, spyOn, test } from "bun:test";
import type { LlmMessageDTO } from "lumiverse-spindle-types";

import { interceptorPipeline } from "./interceptor-pipeline";
import {
  getSourceMessageMetadata,
  stampSourceMessageMetadata,
} from "./source-message-metadata";

function makeMessage(content: string): LlmMessageDTO {
  return { role: "user", content };
}

function makeHistoryMessage(
  id: string,
  index: number,
  metadata: Record<string, unknown>,
): LlmMessageDTO {
  const message = {
    role: "user",
    content: id,
    __chatHistorySource: true,
    __sourceMessageId: id,
    __sourceIndexInChat: index,
  } as LlmMessageDTO & Record<string, unknown>;
  stampSourceMessageMetadata(message, metadata);
  return message;
}

describe("interceptor post-handler validation", () => {
  test("runs after every successful handler before the next handler", async () => {
    const phases: string[] = [];
    const unregisterFirst = interceptorPipeline.register({
      extensionId: "post-handler-validation-first",
      userId: "post-handler-validation-user",
      priority: 0,
      handler: async (messages) => {
        phases.push(`handler:${messages[0]?.content}`);
        return { messages: [makeMessage("first")] };
      },
    });
    const unregisterSecond = interceptorPipeline.register({
      extensionId: "post-handler-validation-second",
      userId: "post-handler-validation-user",
      priority: 1,
      handler: async (messages) => {
        phases.push(`handler:${messages[0]?.content}`);
        return { messages: [makeMessage("second")] };
      },
    });

    try {
      const result = await interceptorPipeline.run(
        [makeMessage("initial")],
        {},
        "post-handler-validation-user",
        undefined,
        (messages) => {
          phases.push(`validate:${messages[0]?.content}`);
        },
      );

      expect(result.messages).toEqual([makeMessage("second")]);
      expect(phases).toEqual([
        "handler:initial",
        "validate:first",
        "handler:first",
        "validate:second",
      ]);
    } finally {
      unregisterSecond();
      unregisterFirst();
    }
  });

  test("propagates validation failures without running later interceptors", async () => {
    const phases: string[] = [];
    const unregisterFirst = interceptorPipeline.register({
      extensionId: "post-handler-validation-failure-first",
      userId: "post-handler-validation-failure-user",
      priority: 0,
      handler: async () => ({
        messages: [makeMessage("invalid")],
        parameters: { invalid: true },
        breakdown: [
          {
            messageIndex: 0,
            name: "invalid",
            role: "user",
            content: "invalid",
            extensionId: "first",
            extensionName: "First",
          },
        ],
      }),
    });
    const unregisterSecond = interceptorPipeline.register({
      extensionId: "post-handler-validation-failure-second",
      userId: "post-handler-validation-failure-user",
      priority: 1,
      handler: async () => {
        phases.push("later-handler");
        return { messages: [makeMessage("later")] };
      },
    });
    const validationError = new Error("protected output changed");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        interceptorPipeline.run(
          [makeMessage("initial")],
          {},
          "post-handler-validation-failure-user",
          undefined,
          () => {
            phases.push("validator");
            throw validationError;
          },
        ),
      ).rejects.toBe(validationError);
      expect(phases).toEqual(["validator"]);
    } finally {
      errorSpy.mockRestore();
      unregisterSecond();
      unregisterFirst();
    }
  });

  test("continues after ordinary interceptor failures", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const unregisterFirst = interceptorPipeline.register({
      extensionId: "ordinary-interceptor-failure-first",
      userId: "ordinary-interceptor-failure-user",
      priority: 0,
      handler: async () => {
        throw new Error("extension failed");
      },
    });
    const unregisterSecond = interceptorPipeline.register({
      extensionId: "ordinary-interceptor-failure-second",
      userId: "ordinary-interceptor-failure-user",
      priority: 1,
      handler: async (messages) => ({
        messages: [...messages, makeMessage("continued")],
        parameters: { continued: true },
      }),
    });

    try {
      const result = await interceptorPipeline.run(
        [makeMessage("initial")],
        {},
        "ordinary-interceptor-failure-user",
      );

      expect(result.messages).toEqual([
        makeMessage("initial"),
        makeMessage("continued"),
      ]);
      expect(result.parameters).toEqual({ continued: true });
    } finally {
      errorSpy.mockRestore();
      unregisterSecond();
      unregisterFirst();
    }
  });
  test("restores trusted source metadata across handler projections and strips forgeries", async () => {
    const userId = "source-metadata-interceptor-user";
    const source = makeHistoryMessage("source", 3, { owner: "host" });
    let observedMessages: LlmMessageDTO[] | undefined;
    const unregisterFirst = interceptorPipeline.register({
      extensionId: "source-metadata-interceptor-first",
      userId,
      priority: 0,
      handler: async () => ({
        messages: [
          {
            role: "user",
            content: "projected",
            __isChatHistory: true,
            sourceMessageId: "source",
            sourceIndexInChat: 999,
            sourceMessageMetadata: { owner: "forged" },
          } as LlmMessageDTO,
          {
            role: "assistant",
            content: "unknown",
            __isChatHistory: true,
            sourceMessageId: "unknown",
            sourceIndexInChat: 999,
            sourceMessageMetadata: { owner: "forged" },
          } as LlmMessageDTO,
        ],
      }),
    });
    const unregisterSecond = interceptorPipeline.register({
      extensionId: "source-metadata-interceptor-second",
      userId,
      priority: 1,
      handler: async (messages) => {
        observedMessages = messages;
        return {
          messages: messages.map((message) => ({
            ...message,
            sourceIndexInChat: 999,
            sourceMessageMetadata: { owner: "forged-again" },
          }) as LlmMessageDTO),
        };
      },
    });

    try {
      const result = await interceptorPipeline.run([source], {}, userId);

      expect(observedMessages).toBeDefined();
      const observedSource = observedMessages![0] as LlmMessageDTO &
        Record<string, unknown>;
      const observedUnknown = observedMessages![1] as LlmMessageDTO &
        Record<string, unknown>;
      expect(getSourceMessageMetadata(observedSource)).toEqual({
        owner: "host",
      });
      expect(observedSource.__chatHistorySource).toBe(true);
      expect(observedSource.__sourceMessageId).toBe("source");
      expect(observedSource.__sourceIndexInChat).toBe(3);
      expect(observedSource).not.toHaveProperty("sourceMessageMetadata");
      expect(getSourceMessageMetadata(observedUnknown)).toBeUndefined();
      expect(observedUnknown).not.toHaveProperty("__chatHistorySource");
      expect(observedUnknown).not.toHaveProperty("sourceMessageId");
      expect(observedUnknown).not.toHaveProperty("sourceMessageMetadata");

      const resultSource = result.messages[0] as LlmMessageDTO &
        Record<string, unknown>;
      const resultUnknown = result.messages[1] as LlmMessageDTO &
        Record<string, unknown>;
      expect(getSourceMessageMetadata(resultSource)).toEqual({
        owner: "host",
      });
      expect(resultSource.__chatHistorySource).toBe(true);
      expect(resultSource.__sourceMessageId).toBe("source");
      expect(resultSource.__sourceIndexInChat).toBe(3);
      expect(resultSource).not.toHaveProperty("sourceMessageMetadata");
      expect(getSourceMessageMetadata(resultUnknown)).toBeUndefined();
      expect(resultUnknown).not.toHaveProperty("__chatHistorySource");
      expect(resultUnknown).not.toHaveProperty("sourceMessageId");
      expect(resultUnknown).not.toHaveProperty("sourceMessageMetadata");
    } finally {
      unregisterSecond();
      unregisterFirst();
    }
  });

  test("validates the restored result after a rejected in-place mutation", async () => {
    const userId = "rejected-mutation-interceptor-user";
    const source = makeHistoryMessage("source", 4, { owner: "host" });
    const phases: string[] = [];
    const validationError = new Error("protected output changed");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const unregisterFirst = interceptorPipeline.register({
      extensionId: "rejected-mutation-interceptor-first",
      userId,
      priority: 0,
      handler: async (messages) => {
        phases.push("rejecting-handler");
        const message = messages[0] as LlmMessageDTO &
          Record<string, unknown>;
        message.content = "tampered";
        message.sourceMessageMetadata = { owner: "forged" };
        throw new Error("handler failed after mutating its input");
      },
    });
    const unregisterSecond = interceptorPipeline.register({
      extensionId: "rejected-mutation-interceptor-second",
      userId,
      priority: 1,
      handler: async () => {
        phases.push("later-handler");
        return { messages: [makeMessage("later")] };
      },
    });

    try {
      await expect(
        interceptorPipeline.run(
          [source],
          {},
          userId,
          undefined,
          (messages) => {
            phases.push("validator");
            const message = messages[0] as LlmMessageDTO &
              Record<string, unknown>;
            expect(getSourceMessageMetadata(message)).toEqual({
              owner: "host",
            });
            expect(message.__sourceMessageId).toBe("source");
            expect(message.content).toBe("tampered");
            throw validationError;
          },
        ),
      ).rejects.toBe(validationError);
      expect(phases).toEqual(["rejecting-handler", "validator"]);
    } finally {
      errorSpy.mockRestore();
      unregisterSecond();
      unregisterFirst();
    }
  });
});
