import { Hono } from "hono";
import * as savedPromptsSvc from "../services/dream-weaver/saved-prompts.service";

const app = new Hono();

// List saved prompts
app.get("/", (c) => {
  const userId = c.get("userId");
  const prompts = savedPromptsSvc.listSavedPrompts(userId);
  return c.json(prompts);
});

// Create saved prompt
app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.prompt) {
    return c.json({ error: "name and prompt are required" }, 400);
  }
  const prompt = savedPromptsSvc.createSavedPrompt(userId, {
    name: body.name,
    prompt: body.prompt,
    negative_prompt: body.negative_prompt,
  });
  return c.json(prompt, 201);
});

// Update saved prompt
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json();
  const prompt = savedPromptsSvc.updateSavedPrompt(userId, id, {
    name: body.name,
    prompt: body.prompt,
    negative_prompt: body.negative_prompt,
  });
  if (!prompt) return c.json({ error: "Saved prompt not found" }, 404);
  return c.json(prompt);
});

// Delete saved prompt
app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const deleted = savedPromptsSvc.deleteSavedPrompt(userId, id);
  if (!deleted) return c.json({ error: "Saved prompt not found" }, 404);
  return c.json({ success: true });
});

export { app as savedPromptsRoutes };
