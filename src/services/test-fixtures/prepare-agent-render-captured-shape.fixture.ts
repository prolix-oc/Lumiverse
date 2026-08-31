import {
  prepareAgentRender,
  shutdownAgenticPreprocessingPool,
} from "../agentic-preprocessing-worker-client";
import { makeRequestEnvelopeV1, preflightEncodedFrame } from "../isolate-protocol";
import {
  HOST_PREPARATION_LIMITS_V1,
  type InputRevisionV1,
  type RenderPreparationInputV1,
} from "../../types/agent-preprocessing";

const TARGET_REVISION_BYTES = 61_515;
const TARGET_FRAME_BYTES = 74_499;
const WIRE_ID = "00000000-0000-4000-8000-000000000000";

function capturedRevisionSet() {
  const regular = (index: number): InputRevisionV1 => ({
    kind: "message",
    id: `message-${index.toString().padStart(4, "0")}-${"i".repeat(40)}`,
    revision: index + 1,
    digest: "d".repeat(64),
  });
  for (let count = 0; count < 1_024; count += 1) {
    const revisions = Array.from({ length: count }, (_value, index) => regular(index));
    const tail: InputRevisionV1 = {
      kind: "message",
      id: "t",
      revision: count + 1,
      digest: "d",
    };
    revisions.push(tail);
    const set = { version: 1 as const, revisions, digest: "frozen-inputs" };
    const missing = TARGET_REVISION_BYTES - Buffer.byteLength(JSON.stringify(set));
    if (missing < 0 || missing > 638) continue;
    const extraId = Math.min(511, missing);
    const extraDigest = missing - extraId;
    if (extraDigest > 127) continue;
    revisions[revisions.length - 1] = {
      ...tail,
      id: "t".repeat(1 + extraId),
      digest: "d".repeat(1 + extraDigest),
    };
    if (Buffer.byteLength(JSON.stringify(set)) === TARGET_REVISION_BYTES) return set;
  }
  throw new Error("Could not reconstruct the captured revision-set byte boundary");
}

function strictFrame(input: RenderPreparationInputV1): Uint8Array {
  const payload = { ...input, requestId: WIRE_ID };
  return preflightEncodedFrame(
    makeRequestEnvelopeV1(WIRE_ID, "prepare_agent_render", payload),
    HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
  );
}

function capturedInput(): RenderPreparationInputV1 {
  const base: RenderPreparationInputV1 = {
    version: 1,
    operation: "prepare_agent_render",
    requestId: "captured-caller-request",
    limits: { ...HOST_PREPARATION_LIMITS_V1 },
    turnId: "captured-turn",
    target: { kind: "swipe", messageId: "target-message", swipeId: 1 },
    // The provider text was not durable before PREPARE_COMMIT. This preserves
    // its recovered UTF-8/JSON byte boundary without claiming its exact words.
    content: { kind: "text", text: "A".repeat(1_009) },
    sourceMessages: [{
      sourceMessageId: "target-message",
      revision: 1,
      role: "assistant",
      content: { kind: "text", text: "" },
      swipeId: 1,
    }],
    swipes: [{
      swipeId: "1",
      index: 1,
      revision: 1,
      content: { kind: "text", text: "prior" },
    }],
    macroSnapshot: { local: [], global: [], chat: [], promptVariables: [] },
    // The frozen snapshot for the failed execution contained exactly no scripts.
    regexScripts: [],
    formatting: {
      stripGuidedReasoning: true,
      healFormatting: true,
      preserveProviderReasoning: true,
    },
    inputRevisions: capturedRevisionSet(),
    deltas: [],
  };
  const missing = TARGET_FRAME_BYTES - strictFrame(base).byteLength;
  if (missing < 0) throw new Error(`Captured frame base exceeds target by ${-missing} bytes`);
  const source = base.sourceMessages[0]!;
  const input: RenderPreparationInputV1 = {
    ...base,
    sourceMessages: [{
      ...source,
      content: { kind: "text", text: "S".repeat(missing) },
    }],
  };
  const frameBytes = strictFrame(input).byteLength;
  if (frameBytes !== TARGET_FRAME_BYTES) {
    throw new Error(`Expected ${TARGET_FRAME_BYTES} frame bytes, got ${frameBytes}`);
  }
  return input;
}

const input = capturedInput();
try {
  const result = await prepareAgentRender(input, {
    userId: "captured-shape",
    timeoutMs: 2_000,
  });
  console.log(JSON.stringify({
    ok: true,
    frameBytes: strictFrame(input).byteLength,
    revisionBytes: Buffer.byteLength(JSON.stringify(input.inputRevisions)),
    regexScripts: input.regexScripts.length,
    renderedBytes: Buffer.byteLength(result.content.kind === "text" ? (result.content.text ?? "") : ""),
  }));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await shutdownAgenticPreprocessingPool();
}
