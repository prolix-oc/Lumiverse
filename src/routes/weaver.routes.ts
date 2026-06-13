import { Hono } from "hono";
import * as svc from "../services/weaver/session.service";
import * as extractionSvc from "../services/weaver/extraction.service";
import * as interviewSvc from "../services/weaver/interview.service";
import * as bibleSvc from "../services/weaver/bible.service";
import * as renderSvc from "../services/weaver/render.service";
import * as finalizeSvc from "../services/weaver/finalize.service";
import * as peopleSvc from "../services/weaver/people.service";
import * as agencySvc from "../services/weaver/agency.service";
import * as importSvc from "../services/weaver/import.service";
import { WEAVER_BUILD_TYPES, getBuildType, DEFAULT_BUILD_TYPE } from "../services/weaver/build-types";
import { getBuildRegistry } from "../services/weaver/build-registry";
import * as tuningSvc from "../services/weaver/tuning";
import { MAX_DYNAMIC_QUESTIONS } from "../services/weaver/dynamic-question.service";
import { HARVEST_CAP } from "../services/weaver/people.service";
import { getWorldbookRole } from "../services/weaver/worldbook-roles";
import { appendBackingWorldbook } from "../services/weaver/worldbook-render.service";
import * as worldBooksSvc from "../services/world-books.service";
import { getCharacterWorldBookIds } from "../utils/character-world-books";
import { startWeaverVisualJob, getWeaverVisualJob } from "../services/weaver/visual/service";
import { getVisualKind, isVisualKind, listVisualKinds, visualCandidateOwner } from "../services/weaver/visual/kinds";
import { suggestVisualTags, buildTagEvidenceFromCharacter } from "../services/weaver/visual/tag-suggester";
import { getVisualProviderAdapter } from "../services/weaver/visual/provider-registry";
import { adapterImageInput } from "../services/weaver/visual/provider-adapter";
import { resolveExpressionVariant, composeExpressionPrompts } from "../services/weaver/visual/expressions";
import * as expressionsSvc from "../services/expressions.service";
import { getCharacter, setCharacterAvatarFromImage } from "../services/characters.service";
import { getConnection, imageGenConnectionSecretKey } from "../services/image-gen-connections.service";
import { getImageGenSettings } from "../services/image-gen.service";
import * as imagesSvc from "../services/images.service";
import * as secretsSvc from "../services/secrets.service";
import type {
  CreateWeaverSessionInput,
  UpdateWeaverSessionInput,
  UpdateWeaverExtractionInput,
  GenerateQuestionInput,
  AnswerInterviewQuestionInput,
  SparkQuestionInput,
  EnhanceAnswerInput,
  UpdateWeaverBibleInput,
  RenderFieldsInput,
  EditWeaverFieldInput,
  AcceptWeaverFieldInput,
  NudgeWeaverFieldInput,
  WeaverVisualGenerateInput,
} from "../types/weaver";

const app = new Hono();

function publicWeaverError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message.includes("no connection")) return "Choose a text connection before running the Weaver.";
    if (err.message.includes("no model")) return "Choose a model before running the Weaver.";
    if (err.message === "Seed is empty — nothing to read back") return err.message;
    if (err.message === "Read the dream first — there is nothing to synthesize") return err.message;
    if (err.message.includes("invalid JSON")) return "The model's response could not be parsed. Try again or switch models.";
    if (err.message.includes("no usable options")) return "The model returned no usable options. Try again or switch models.";
    if (err.message.includes("unusable Bible")) return "The model returned an unusable Bible. Try again or switch models.";
    if (err.message.startsWith("Synthesize a Bible first")) return err.message;
    if (err.message.startsWith("The Bible has no spine yet")) return err.message;
    if (err.message.startsWith("Unknown field")) return err.message;
    if (err.message.startsWith("This field is hand-edited")) return err.message;
    if (err.message.startsWith("Render the field first")) return err.message;
    if (err.message === "A field cannot be empty") return err.message;
    if (err.message === "Add a nudge to steer the re-render") return err.message;
    if (err.name === "AbortError" || err.message.toLowerCase().includes("abort")) return "Generation was canceled.";
  }
  return "That step could not finish. Check the connection and try again.";
}

app.post("/sessions", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as CreateWeaverSessionInput;
  try {
    const session = svc.createSession(userId, body);
    return c.json(session, 201);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not create the session";
    return c.json({ error: message }, 400);
  }
});

app.get("/sessions", (c) => {
  const userId = c.get("userId");
  return c.json(svc.listSessions(userId));
});

app.get("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const session = svc.getSession(userId, c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

app.patch("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as UpdateWeaverSessionInput;
  try {
    const session = svc.updateSession(userId, c.req.param("id"), body);
    return c.json(session);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.delete("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteSession(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Session not found" }, 404);
  return c.json({ success: true });
});

app.get("/build-types", (c) => c.json(WEAVER_BUILD_TYPES));

app.post("/import/inspect", async (c) => {
  const userId = c.get("userId");
  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Send the file as multipart/form-data" }, 400);
  }
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file is required" }, 400);
  const connectionId = formData.get("connection_id");
  const model = formData.get("model");
  try {
    const inspection = await importSvc.inspectImport(userId, file, {
      connection_id: typeof connectionId === "string" && connectionId.trim() ? connectionId.trim() : null,
      model: typeof model === "string" && model.trim() ? model.trim() : null,
    });
    return c.json(inspection);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not read this file";
    return c.json({ error: message }, 400);
  }
});

app.post("/import/start", async (c) => {
  const userId = c.get("userId");
  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Send the file as multipart/form-data" }, 400);
  }
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file is required" }, 400);
  const action = formData.get("action");
  if (typeof action !== "string" || !action.trim()) return c.json({ error: "action is required" }, 400);
  const str = (key: string) => {
    const v = formData.get(key);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  try {
    const result = await importSvc.startImport(userId, file, {
      action: action.trim(),
      connection_id: str("connection_id"),
      model: str("model"),
      persona_id: str("persona_id"),
    });
    return c.json(result, 201);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not start from this file";
    return c.json({ error: message }, 400);
  }
});

app.post("/import/enrich/:bookId/entries/:entryId", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as { connection_id?: string; model?: string };
  try {
    const result = await importSvc.enrichEntry(
      userId,
      c.req.param("bookId"),
      c.req.param("entryId"),
      { connection_id: body.connection_id ?? null, model: body.model ?? null },
    );
    return c.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not enrich this entry";
    if (message === "No such entry in this book") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

function requestedBuildType(c: { req: { query(name: string): string | undefined } }): string | null {
  const raw = c.req.query("build_type")?.trim();
  if (!raw) return DEFAULT_BUILD_TYPE;
  return getBuildType(raw) ? raw : null;
}

app.get("/slots", (c) => {
  const buildType = requestedBuildType(c);
  if (!buildType) return c.json({ error: "Unknown build type" }, 400);
  const reg = getBuildRegistry(buildType);
  const bookRoles = reg.finalizeBookRoles
    .map((id) => getWorldbookRole(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ id: r.id, label: r.label, defaultEnabled: r.defaultEnabled, triggering: r.triggering }));
  return c.json({ slots: reg.slots, groups: reg.synthesisGroups, bookRoles });
});

app.get("/field-defs", (c) => {
  const buildType = requestedBuildType(c);
  if (!buildType) return c.json({ error: "Unknown build type" }, 400);
  return c.json(getBuildRegistry(buildType).fieldDefs);
});

function tuningDefaults(): Record<string, number> {
  const people = WEAVER_BUILD_TYPES.map((t) => getBuildRegistry(t.id).people).find(Boolean);
  return {
    ...(people
      ? { propose_count: people.proposeCount, named_question_target: people.namedQuestionTarget }
      : {}),
    dynamic_question_cap: MAX_DYNAMIC_QUESTIONS,
    harvest_cap: HARVEST_CAP,
  };
}

app.get("/tuning", (c) => {
  const userId = c.get("userId");
  return c.json({ tuning: tuningSvc.getWeaverTuning(userId), defaults: tuningDefaults() });
});

app.put("/tuning", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  return c.json({ tuning: tuningSvc.setWeaverTuning(userId, body), defaults: tuningDefaults() });
});

app.get("/sessions/:id/extraction", (c) => {
  const userId = c.get("userId");
  const extraction = extractionSvc.getExtraction(userId, c.req.param("id"));
  if (!extraction) return c.json({ error: "Extraction not found" }, 404);
  return c.json(extraction);
});

app.post("/sessions/:id/readback", async (c) => {
  const userId = c.get("userId");
  try {
    const extraction = await extractionSvc.runReadback(userId, c.req.param("id"));
    return c.json(extraction);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Read-back failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.patch("/sessions/:id/extraction", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as UpdateWeaverExtractionInput;
  try {
    const extraction = extractionSvc.updateExtraction(userId, c.req.param("id"), body);
    return c.json(extraction);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    if (message === "Extraction not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.get("/sessions/:id/interview", (c) => {
  const userId = c.get("userId");
  if (!svc.getSession(userId, c.req.param("id"))) return c.json({ error: "Session not found" }, 404);
  return c.json(interviewSvc.getInterviewState(userId, c.req.param("id")));
});

app.post("/sessions/:id/interview/question", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as GenerateQuestionInput;
  try {
    const question = await interviewSvc.generateQuestion(userId, c.req.param("id"), body);
    return c.json({ question });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Question generation failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/interview/answer", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as AnswerInterviewQuestionInput;
  try {
    const state = await interviewSvc.answerQuestion(userId, c.req.param("id"), body);
    return c.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Answer failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.post("/sessions/:id/interview/spark", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as SparkQuestionInput;
  try {
    const options = await interviewSvc.sparkQuestion(userId, c.req.param("id"), body);
    return c.json({ options });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Spark failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/interview/enhance", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as EnhanceAnswerInput;
  try {
    const options = await interviewSvc.enhanceAnswer(userId, c.req.param("id"), body);
    return c.json({ options });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Enhance failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    if (message.startsWith("Write a draft answer first")) return c.json({ error: message }, 400);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/interview/optin", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as { slot?: unknown; enabled?: unknown };
  if (typeof body.slot !== "string" || !body.slot.trim() || typeof body.enabled !== "boolean") {
    return c.json({ error: "An opt-in decision needs a slot and enabled" }, 400);
  }
  try {
    return c.json(interviewSvc.decideOptIn(userId, c.req.param("id"), body.slot.trim(), body.enabled));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Opt-in failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.post("/sessions/:id/interview/begin", (c) => {
  const userId = c.get("userId");
  try {
    return c.json(interviewSvc.beginInterview(userId, c.req.param("id")));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Begin failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.post("/sessions/:id/interview/complete", (c) => {
  const userId = c.get("userId");
  try {
    return c.json(interviewSvc.completeInterview(userId, c.req.param("id")));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Complete failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.post("/sessions/:id/interview/reset", (c) => {
  const userId = c.get("userId");
  try {
    const state = interviewSvc.resetInterview(userId, c.req.param("id"));
    return c.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Reset failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.get("/sessions/:id/bible", (c) => {
  const userId = c.get("userId");
  if (!svc.getSession(userId, c.req.param("id"))) return c.json({ error: "Session not found" }, 404);
  const bible = bibleSvc.getBible(userId, c.req.param("id"));
  if (!bible) return c.json({ error: "Bible not found" }, 404);
  return c.json(bible);
});

app.post("/sessions/:id/bible/synthesize", async (c) => {
  const userId = c.get("userId");
  try {
    const bible = await bibleSvc.synthesizeBible(userId, c.req.param("id"));
    return c.json(bible);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Synthesis failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/bible/gate", async (c) => {
  const userId = c.get("userId");
  try {
    const bible = await bibleSvc.gateBible(userId, c.req.param("id"));
    return c.json(bible);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Check failed";
    if (message === "Session not found" || message === "No Bible to check yet")
      return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.patch("/sessions/:id/bible", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as UpdateWeaverBibleInput;
  try {
    const bible = bibleSvc.updateBible(userId, c.req.param("id"), body);
    return c.json(bible);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    if (message === "No Bible to edit yet") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.get("/sessions/:id/fields", (c) => {
  const userId = c.get("userId");
  if (!svc.getSession(userId, c.req.param("id"))) return c.json({ error: "Session not found" }, 404);
  return c.json(renderSvc.getFields(userId, c.req.param("id")));
});

app.post("/sessions/:id/fields/render", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as RenderFieldsInput;
  try {
    if (body.field_id) {
      const field = await renderSvc.renderField(userId, c.req.param("id"), body.field_id, { force: body.force });
      return c.json([field]);
    }
    const fields = await renderSvc.renderAllFields(userId, c.req.param("id"));
    return c.json(fields);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Render failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/fields/:field/render", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as RenderFieldsInput;
  try {
    const field = await renderSvc.reRenderField(userId, c.req.param("id"), c.req.param("field"), {
      force: body.force,
    });
    return c.json(field);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Render failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.patch("/sessions/:id/fields/:field", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as EditWeaverFieldInput;
  try {
    const field = renderSvc.editField(userId, c.req.param("id"), c.req.param("field"), body.content ?? "");
    return c.json(field);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Edit failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/fields/:field/accept", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as AcceptWeaverFieldInput;
  try {
    const field = renderSvc.acceptField(userId, c.req.param("id"), c.req.param("field"), body.accepted === true);
    return c.json(field);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Accept failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/fields/:field/nudge", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as NudgeWeaverFieldInput;
  try {
    const field = await renderSvc.reRenderWithNudge(userId, c.req.param("id"), c.req.param("field"), body.nudge ?? "", {
      force: body.force,
    });
    return c.json(field);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Nudge failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/finalize", async (c) => {
  const userId = c.get("userId");
  try {
    const body = await c.req.json().catch(() => ({}));
    const books: Record<string, boolean> = {};
    if (body?.books && typeof body.books === "object" && !Array.isArray(body.books)) {
      for (const [roleId, enabled] of Object.entries(body.books as Record<string, unknown>)) {
        if (typeof enabled === "boolean") books[roleId] = enabled;
      }
    }
    const result = await finalizeSvc.finalizeSession(userId, c.req.param("id"), {
      books,
      ...(typeof body?.depth_book === "boolean" ? { depthBook: body.depth_book } : {}),
    });

    // Seed the roster with the people the author's own material already names, so the
    // hub opens with the world's actual people. Failure-soft: never sinks a finalize.
    const finalized = svc.getSession(userId, c.req.param("id"));
    if (finalized && getBuildRegistry(finalized.build_type).people) {
      try {
        await peopleSvc.harvestPeople(userId, finalized);
      } catch (err) {
        console.warn("[weaver] People harvest after finalize failed:", err);
      }
    }
    return c.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Finalize failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

function growableSession(c: any, userId: string): { session: ReturnType<typeof svc.getSession>; error?: never } | { session?: never; error: Response } {
  const session = svc.getSession(userId, c.req.param("id"));
  if (!session) return { error: c.json({ error: "Session not found" }, 404) };
  if (session.status !== "finalized" || !session.character_id) {
    return { error: c.json({ error: "Finalize the card first — growth starts from the hub" }, 400) };
  }
  return { session };
}

app.get("/sessions/:id/hub", (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  const character = getCharacter(userId, session!.character_id!);
  if (!character) return c.json({ error: "The finalized card no longer exists" }, 404);

  const reg = getBuildRegistry(session!.build_type);
  const books = getCharacterWorldBookIds(character.extensions)
    .map((id) => worldBooksSvc.getWorldBook(userId, id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
    .filter((b) => {
      const meta = (b.metadata ?? {}) as Record<string, unknown>;
      return meta.source === "weaver" && meta.source_character_id === character.id;
    })
    .map((b) => ({
      id: b.id,
      name: b.name,
      role: ((b.metadata ?? {}) as Record<string, unknown>).weaver_role ?? null,
      entry_count: worldBooksSvc.getWorldBookEntriesSignature(b.id).count,
    }));

  const inUniverse = reg.people
    ? peopleSvc.listInUniverse(userId, session!)
    : { characters: [], promotions: [] };

  return c.json({
    character_id: character.id,
    character_name: character.name,
    build_type: session!.build_type,
    book_roles: reg.finalizeBookRoles,
    people: reg.people
      ? {
          question_target:
            tuningSvc.getWeaverTuning(userId).named_question_target ?? reg.people.namedQuestionTarget,
        }
      : null,
    agency: agencySvc.getAgencyState(userId, session!),
    books,
    characters: inUniverse.characters,
    promotions: inUniverse.promotions,
  });
});

app.post("/sessions/:id/agency", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "The agency toggle needs enabled" }, 400);
  }
  try {
    return c.json({ agency: agencySvc.setAgencyEnabled(userId, session!, body.enabled) });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Agency toggle failed" }, 400);
  }
});

app.put("/sessions/:id/agency", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as { agenda?: unknown; holds?: unknown };
  try {
    return c.json({ agency: agencySvc.updateAgency(userId, session!, body) });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Agency update failed" }, 400);
  }
});

app.post("/sessions/:id/lore/question", async (c) => {
  const userId = c.get("userId");
  const { error } = growableSession(c, userId);
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as GenerateQuestionInput;
  try {
    const question = await interviewSvc.generateQuestion(userId, c.req.param("id"), body, undefined, {
      ignoreCap: true,
    });
    return c.json({ question });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Question generation failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/lore/answer", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as AnswerInterviewQuestionInput;
  try {
    await interviewSvc.answerQuestion(userId, c.req.param("id"), body);
    bibleSvc.syncDynamicRegion(userId, c.req.param("id"));

    const character = getCharacter(userId, session!.character_id!);
    const roleId = getBuildRegistry(session!.build_type).finalizeBookRoles[0];
    let book: { id: string; name: string; entry_count: number } | null = null;
    let added = 0;
    let bookError: string | undefined;
    if (character && roleId) {
      try {
        const res = await appendBackingWorldbook(userId, session!, roleId, character);
        added = res.added;
        if (res.book) {
          book = {
            id: res.book.id,
            name: res.book.name,
            entry_count: worldBooksSvc.getWorldBookEntriesSignature(res.book.id).count,
          };
        }
      } catch (err) {
        bookError = err instanceof Error ? err.message : "The book could not be updated";
      }
    }

    return c.json({ added, book, ...(bookError ? { book_error: bookError } : {}) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Answer failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: message }, 400);
  }
});

app.get("/sessions/:id/people", (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  if (!getBuildRegistry(session!.build_type).people) {
    return c.json({ error: "This build type has no people" }, 400);
  }
  return c.json({ people: peopleSvc.listPeople(userId, session!.id) });
});

app.post("/sessions/:id/people/propose", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  try {
    const proposed = await peopleSvc.proposePeople(userId, session!);
    return c.json({ proposed, people: peopleSvc.listPeople(userId, session!.id) });
  } catch (err: unknown) {
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/people", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; hook?: unknown };
  try {
    const person = peopleSvc.addPerson(userId, session!.id, body);
    return c.json({ person });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Could not add the person" }, 400);
  }
});

app.delete("/sessions/:id/people/:personId", (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  try {
    peopleSvc.removePerson(userId, session!.id, c.req.param("personId"));
    return c.json({ removed: true });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Could not remove the person" }, 400);
  }
});

app.post("/sessions/:id/people/:personId/extra", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  try {
    const result = await peopleSvc.fleshExtra(userId, session!, c.req.param("personId"));
    return c.json({ person: result.person, book: { id: result.book.id, name: result.book.name } });
  } catch (err: unknown) {
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/people/:personId/question", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as { avoid?: string[] };
  try {
    const question = await peopleSvc.personQuestion(userId, session!, c.req.param("personId"), body);
    return c.json({ question });
  } catch (err: unknown) {
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/people/:personId/answer", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const person = peopleSvc.answerPersonQuestion(userId, session!, c.req.param("personId"), body);
    return c.json({ person });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Answer failed" }, 400);
  }
});

app.post("/sessions/:id/people/:personId/promote", (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  try {
    const promoted = peopleSvc.promoteNamed(userId, session!, c.req.param("personId"));
    return c.json({ session: promoted });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Promotion failed" }, 400);
  }
});

app.post("/sessions/:id/people/:personId/weave", async (c) => {
  const userId = c.get("userId");
  const { session, error } = growableSession(c, userId);
  if (error) return error;
  try {
    const result = await peopleSvc.weaveNamed(userId, session!, c.req.param("personId"));
    return c.json({ person: result.person, book: { id: result.book.id, name: result.book.name } });
  } catch (err: unknown) {
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/start-chat", async (c) => {
  const userId = c.get("userId");
  try {
    const result = finalizeSvc.startChat(userId, c.req.param("id"));
    return c.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not start the chat";
    if (message === "Session not found") return c.json({ error: message }, 404);
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.get("/visual/kinds", (c) => c.json(listVisualKinds()));

function visualMacroValues(character: ReturnType<typeof getCharacter>): Record<string, string | undefined> {
  if (!character) return {};
  return {
    name: character.name ?? undefined,
    description: typeof character.description === "string" ? character.description : undefined,
  };
}

async function loadSourceImage(
  userId: string,
  imageId: string,
): Promise<{ data: string; mimeType: string } | null> {
  const image = imagesSvc.getImage(userId, imageId);
  if (!image) return null;
  const path = await imagesSvc.getImageFilePath(userId, imageId);
  if (!path) return null;
  const bytes = await Bun.file(path).arrayBuffer();
  return {
    data: Buffer.from(bytes).toString("base64"),
    mimeType: image.mime_type || "image/png",
  };
}

app.post("/sessions/:id/visual/generate", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as WeaverVisualGenerateInput;

  const session = svc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.status !== "finalized" || !session.character_id) {
    return c.json({ error: "Finalize the character before generating visuals." }, 400);
  }
  if (!body.kind || !isVisualKind(body.kind)) {
    return c.json({ error: "Unknown image kind." }, 400);
  }
  const kindMeta = getVisualKind(body.kind)!;
  if (!body.connection_id) {
    return c.json({ error: "Choose an image connection." }, 400);
  }

  const character = getCharacter(userId, session.character_id);
  if (!character) return c.json({ error: "Character not found" }, 404);

  const connection = getConnection(userId, body.connection_id);
  if (!connection) return c.json({ error: "Image connection not found" }, 404);

  let sourceImage: { data: string; mimeType: string } | undefined;
  if (body.source_image_id) {
    const adapter = getVisualProviderAdapter(connection.provider as Parameters<typeof getVisualProviderAdapter>[0]);
    if (!adapter) return c.json({ error: "That image provider is not supported for Visual Studio." }, 400);
    const support = adapterImageInput(adapter, connection);
    if (!support.supported) {
      return c.json({ error: support.reason ?? "This connection cannot take an image as input." }, 400);
    }
    const loaded = await loadSourceImage(userId, body.source_image_id);
    if (!loaded) return c.json({ error: "The source image no longer exists." }, 404);
    sourceImage = loaded;

    if (kindMeta.variants && body.variant?.trim()) {
      const variant = resolveExpressionVariant(body.variant);
      const composed = composeExpressionPrompts(
        variant,
        support.mechanism!,
        body.prompt?.trim() ?? "",
        body.negative_prompt?.trim() ?? "",
      );
      body.variant = variant.id;
      body.prompt = composed.prompt;
      body.negative_prompt = composed.negative_prompt || undefined;
    }
  }
  if (kindMeta.variants) {
    if (!body.variant?.trim()) return c.json({ error: "Choose an expression to generate." }, 400);
    if (!sourceImage) return c.json({ error: "Commit a portrait first — expressions are derived from it." }, 400);
  }
  if (!body.prompt?.trim()) {
    return c.json({ error: "A prompt is required." }, 400);
  }

  const apiKey = (await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(connection.id))) ?? "";

  const timeoutSecs = getImageGenSettings(userId).generationTimeoutSeconds ?? 300;
  const controller = timeoutSecs > 0 ? new AbortController() : null;
  const timeoutHandle = controller
    ? setTimeout(() => controller.abort(new Error(`Visual generation timed out after ${timeoutSecs}s`)), timeoutSecs * 1000)
    : null;

  const characterId = session.character_id;
  const job = startWeaverVisualJob({
    userId,
    sessionId,
    characterId,
    input: body,
    connection,
    apiKey,
    sourceImage,
    macroValues: visualMacroValues(character),
    signal: controller?.signal,
    onSettled: timeoutHandle !== null ? () => clearTimeout(timeoutHandle) : undefined,
    persistResult: async ({ job, result }) => {
      if (!result.image_url || !result.image_url.startsWith("data:image/")) {
        return result;
      }
      const image = await imagesSvc.saveImageFromDataUrl(
        userId,
        result.image_url,
        `${imagesSvc.IMAGE_GEN_FILENAME_PREFIX}weaver-${characterId}-${job.kind}-${job.id}.png`,
        {
          owner_character_id: characterId,
          owner_extension_identifier: visualCandidateOwner(job.kind, job.variant),
        },
      );
      return { ...result, image_id: image.id, image_url: undefined };
    },
  });

  return c.json(job, 201);
});

app.get("/sessions/:id/visual/image-input", (c) => {
  const userId = c.get("userId");
  const session = svc.getSession(userId, c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  const connectionId = c.req.query("connection_id");
  if (!connectionId) return c.json({ error: "Choose an image connection." }, 400);
  const connection = getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Image connection not found" }, 404);

  const adapter = getVisualProviderAdapter(connection.provider as Parameters<typeof getVisualProviderAdapter>[0]);
  if (!adapter) {
    return c.json({ supported: false, mechanism: null, reason: "That image provider is not supported for Visual Studio." });
  }
  return c.json(adapterImageInput(adapter, connection));
});

app.get("/sessions/:id/visual/job/:jobId", (c) => {
  const userId = c.get("userId");
  const job = getWeaverVisualJob(userId, c.req.param("jobId"));
  if (!job || job.sessionId !== c.req.param("id")) {
    return c.json({ error: "Job not found" }, 404);
  }
  return c.json(job);
});

app.get("/sessions/:id/visual/candidates", (c) => {
  const userId = c.get("userId");
  const kind = c.req.query("kind");
  if (!kind || !isVisualKind(kind)) {
    return c.json({ error: "Unknown image kind." }, 400);
  }
  const session = svc.getSession(userId, c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (!session.character_id) return c.json({ data: [], total: 0 });

  const result = imagesSvc.listImages(userId, {
    owner_character_id: session.character_id,
    owner_extension_identifier: visualCandidateOwner(kind, c.req.query("variant")),
    limit: 200,
  });
  return c.json(result);
});

app.post("/sessions/:id/visual/suggest-tags", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");

  const session = svc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.status !== "finalized" || !session.character_id) {
    return c.json({ error: "Finalize the character before suggesting tags." }, 400);
  }
  const character = getCharacter(userId, session.character_id);
  if (!character) return c.json({ error: "Character not found" }, 404);

  try {
    const evidence = buildTagEvidenceFromCharacter(character);
    const tags = await suggestVisualTags({ userId, session, evidence });
    return c.json(tags);
  } catch (err) {
    return c.json({ error: publicWeaverError(err) }, 400);
  }
});

app.post("/sessions/:id/visual/commit/avatar", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { image_id?: string };

  const session = svc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.status !== "finalized" || !session.character_id) {
    return c.json({ error: "Finalize the character before committing visuals." }, 400);
  }
  if (!body.image_id) return c.json({ error: "image_id is required" }, 400);

  const character = setCharacterAvatarFromImage(userId, session.character_id, body.image_id);
  if (!character) return c.json({ error: "Image or character not found" }, 404);
  return c.json(character);
});

app.post("/sessions/:id/visual/commit/expressions", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as { mappings?: Record<string, unknown> };

  const session = svc.getSession(userId, c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.status !== "finalized" || !session.character_id) {
    return c.json({ error: "Finalize the character before committing visuals." }, 400);
  }

  const mappings: Record<string, string> = {};
  for (const [label, imageId] of Object.entries(body.mappings ?? {})) {
    const cleanLabel = label.trim().toLowerCase();
    if (!cleanLabel || typeof imageId !== "string" || !imageId.trim()) continue;
    if (!imagesSvc.getImage(userId, imageId)) {
      return c.json({ error: "An image in the mapping no longer exists." }, 404);
    }
    mappings[cleanLabel] = imageId;
  }
  if (Object.keys(mappings).length === 0) {
    return c.json({ error: "Nothing to commit — provide label to image mappings." }, 400);
  }

  const config = expressionsSvc.mapFromGallery(userId, session.character_id, mappings);
  return c.json(config);
});

export { app as weaverRoutes };
