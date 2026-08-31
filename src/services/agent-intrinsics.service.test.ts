import { describe, expect, test } from "bun:test";

import type {
  AgentConfigV2,
  AgentProfileConfigV2,
} from "../types/agents";
import {
  AgentDryRunUnsupportedError,
  AgentIntrinsicValidationError,
  AgentMultiplayerUnsupportedError,
  preflightAgentIntrinsics,
  resolveAgentFeatureRuntimeAdmission,
  type AgentIntrinsicBlockInput,
  type AgentIntrinsicValidationReasonCode,
} from "./agent-intrinsics.service";

const PROFILE_ID = "research";

function makeProfile(
  overrides: Partial<AgentProfileConfigV2> = {},
): AgentProfileConfigV2 {
  return {
    id: PROFILE_ID,
    name: "Research",
    systemPrompt: "You are a research child.",
    connectionRef: { kind: "inherit_main" },
    toolIds: ["lore_search_entries", "chat_search_history"],
    loreScope: "active",
    allowMainDelegation: false,
    failurePolicy: "required",
    streamActivity: true,
    maxOutputTokens: 256,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<AgentConfigV2> = {},
  profileOverrides: Partial<AgentProfileConfigV2> = {},
): AgentConfigV2 {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response"],
    defaultMode: "response",
    maxInvocations: 64,
    maxToolCalls: 64,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [makeProfile(profileOverrides)],
    connectionSlots: [],
    ...overrides,
  };
}

describe("resolveAgentFeatureRuntimeAdmission", () => {
  test("admits configured runtime work only in a real single-user generation", () => {
    const mainTools = makeConfig({ mainToolIds: ["chat_search_history"] });
    expect(resolveAgentFeatureRuntimeAdmission({
      config: mainTools,
      hasExecutableIntrinsic: false,
      dryRun: false,
      activeMultiplayer: false,
    })).toBe(true);
    expect(resolveAgentFeatureRuntimeAdmission({
      config: mainTools,
      hasExecutableIntrinsic: false,
      dryRun: true,
      activeMultiplayer: false,
    })).toBe(false);
    expect(resolveAgentFeatureRuntimeAdmission({
      config: mainTools,
      hasExecutableIntrinsic: false,
      dryRun: false,
      activeMultiplayer: true,
    })).toBe(false);
    expect(resolveAgentFeatureRuntimeAdmission({
      config: undefined,
      hasExecutableIntrinsic: false,
      dryRun: false,
      activeMultiplayer: false,
    })).toBe(false);
  });

  test("fails executable intrinsics instead of silently stripping them by mode", () => {
    expect(() => resolveAgentFeatureRuntimeAdmission({
      config: makeConfig(),
      hasExecutableIntrinsic: true,
      dryRun: true,
      activeMultiplayer: false,
    })).toThrow(AgentDryRunUnsupportedError);
    expect(() => resolveAgentFeatureRuntimeAdmission({
      config: makeConfig(),
      hasExecutableIntrinsic: true,
      dryRun: false,
      activeMultiplayer: true,
    })).toThrow(AgentMultiplayerUnsupportedError);
  });
});

function block(
  content: string,
  overrides: Partial<AgentIntrinsicBlockInput> = {},
): AgentIntrinsicBlockInput {
  return {
    id: "block-0",
    role: "user",
    enabled: true,
    content,
    ...overrides,
  };
}

function intrinsic(options = ""): string {
  const suffix = options ? `::${options}` : "";
  return `{{agent::${PROFILE_ID}${suffix}}}child task{{/agent}}`;
}

function expectReason(
  run: () => unknown,
  reason: AgentIntrinsicValidationReasonCode,
): AgentIntrinsicValidationError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentIntrinsicValidationError);
  if (!(caught instanceof AgentIntrinsicValidationError)) {
    throw new Error("expected AgentIntrinsicValidationError");
  }
  expect(caught.reasonCode).toBe(reason);
  expect(caught.blockIndex).toBeGreaterThanOrEqual(0);
  expect(caught.blockId).toBeTruthy();
  return caught;
}

describe("preflightAgentIntrinsics", () => {
  test("parses order-independent options and retains exact task/span data", () => {
    const content = intrinsic(
      "tools=chat_search_history,lore_search_entries::stream::as=answer",
    );
    const plan = preflightAgentIntrinsics([block(content)], makeConfig());
    const invocation = plan.executableIntrinsics[0];

    expect(invocation).toBeDefined();
    expect(invocation?.profileId).toBe(PROFILE_ID);
    expect(invocation?.taskTemplate).toBe("child task");
    expect(invocation?.resultName).toBe("answer");
    expect(invocation?.toolIds).toEqual([
      "chat_search_history",
      "lore_search_entries",
    ]);
    expect(invocation?.stream).toBe(true);
    expect(invocation?.start).toBe(0);
    expect(invocation?.end).toBe(content.length);
    expect(plan.nodeCount).toBe(1);
  });

  test("rejects duplicate and unknown options without leaking task text", () => {
    const duplicateError = expectReason(
      () => preflightAgentIntrinsics([block(intrinsic("stream::stream"))], makeConfig()),
      "duplicate_option",
    );
    expect(duplicateError.message).not.toContain("child task");

    expectReason(
      () => preflightAgentIntrinsics([block(intrinsic("unknown=value"))], makeConfig()),
      "unknown_option",
    );
  });

  test("rejects malformed openings, closures, nesting, and empty tasks", () => {
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block("{{agent::research::as=result}}unfinished")],
          makeConfig(),
        ),
      "malformed_closing",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block(`prefix ${intrinsic()}`)],
          makeConfig(),
        ),
      "malformed_opening",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block("{{agent::research}}{{agent::research}}nested{{/agent}}{{/agent}}")],
          makeConfig(),
        ),
      "nested_intrinsic",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block("{{agent::research}}{{/agent}}")],
          makeConfig(),
        ),
      "empty_task",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block("{{agent::research}} \n\t {{/agent}}")],
          makeConfig(),
        ),
      "empty_task",
    );
    expectReason(
      () => preflightAgentIntrinsics([block("ordinary {{/agent}} text")], makeConfig()),
      "malformed_closing",
    );
  });

  test("enforces enabled user placement, profile lookup, tool narrowing, and stream ceiling", () => {
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block(intrinsic(), { role: "assistant" })],
          makeConfig(),
        ),
      "non_user_block",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block("{{agentResult::facts}}", { role: "system" })],
          makeConfig(),
        ),
      "non_user_block",
    );
    expectReason(
      () => preflightAgentIntrinsics([block("{{agent::missing}}task{{/agent}}")], makeConfig()),
      "unknown_profile",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block(intrinsic("tools=lore_get_entry"))],
          makeConfig({}, { toolIds: ["chat_search_history"] }),
        ),
      "tool_not_allowed",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block(intrinsic("stream"))],
          makeConfig({}, { streamActivity: false }),
        ),
      "stream_not_allowed",
    );
  });

  test("ignores disabled blocks for enabled and disabled feature configs", () => {
    const disabledBlock = block(
      "{{agent::missing}}malformed without close",
      { enabled: false },
    );
    for (const agentsEnabled of [true, false]) {
      const plan = preflightAgentIntrinsics(
        [disabledBlock],
        makeConfig({ agentsEnabled }),
      );
      expect(plan.nodeCount).toBe(0);
      expect(plan.executableIntrinsics).toHaveLength(0);
      expect(plan.blocks[0].replacementContent).toBe(disabledBlock.content);
    }
  });

  test("validates producer uniqueness and reference order before execution", () => {
    const producer = block(intrinsic("as=result"), { id: "producer" });
    const reference = block("before {{agentResult::result}} after", { id: "reference" });
    const valid = preflightAgentIntrinsics([producer, reference], makeConfig());
    expect(valid.resultReferences[0]?.start).toBe(7);
    expect(valid.resultReferences[0]?.end).toBe(30);

    expectReason(
      () =>
        preflightAgentIntrinsics(
          [reference, producer],
          makeConfig(),
        ),
      "forward_reference",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [block("{{agentResult::missing}}", { id: "missing-ref" })],
          makeConfig(),
        ),
      "missing_reference",
    );
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [producer, block(intrinsic("as=result"), { id: "duplicate" })],
          makeConfig(),
        ),
      "duplicate_producer",
    );
  });
  test("validates producer and reference ordering only across traversed blocks", () => {
    const skippedProducer = block(intrinsic("as=result"), {
      id: "skipped-producer",
      active: false,
    });
    const activeReference = block("before {{agentResult::result}} after", {
      id: "active-reference",
      active: true,
    });
    expectReason(
      () =>
        preflightAgentIntrinsics(
          [skippedProducer, activeReference],
          makeConfig(),
        ),
      "missing_reference",
    );

    const skippedMalformedReference = block("{{agentResult::missing}}", {
      id: "skipped-reference",
      active: false,
    });
    const plan = preflightAgentIntrinsics(
      [skippedMalformedReference],
      makeConfig(),
    );
    expect(plan.nodeCount).toBe(0);
    expect(plan.resultReferences).toHaveLength(0);
  });


  test("caps executable and reference nodes at 32", () => {
    const blocks = Array.from({ length: 33 }, (_, index) =>
      block(intrinsic(), { id: `block-${index}` }),
    );
    expectReason(
      () => preflightAgentIntrinsics(blocks, makeConfig()),
      "node_limit_exceeded",
    );
  });

  test("leaves all syntax inert and byte-for-byte when config is absent", () => {
    const content = ` malformed {{agent::not_valid}}task{{/agent}}\n{{agentResult::missing}} `;
    const plan = preflightAgentIntrinsics([block(content)], undefined);

    expect(plan.configPresent).toBe(false);
    expect(plan.nodeCount).toBe(0);
    expect(plan.blocks[0]?.replacementContent).toBe(content);
    expect(plan.blocks[0]?.originalContent).toBe(content);
  });

  test("strips valid disabled syntax while preserving ordinary content around refs", () => {
    const producer = block(intrinsic("as=result"), { id: "producer" });
    const content = "left\n{{agentResult::result}}\nright";
    const reference = block(content, { id: "reference" });
    const plain = block("ordinary {{notAnAgentMacro}} text", { id: "plain" });
    const plan = preflightAgentIntrinsics(
      [producer, reference, plain],
      makeConfig({ agentsEnabled: false }),
    );

    expect(plan.agentsEnabled).toBe(false);
    expect(plan.blocks.map((entry) => entry.replacementContent)).toEqual([
      "",
      "left\n\nright",
      "ordinary {{notAnAgentMacro}} text",
    ]);
    expect(plan.blocks[1]?.originalContent).toBe(content);
  });
});
