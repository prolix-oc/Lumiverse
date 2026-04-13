import { getDb } from "../../db/connection";

export interface SavedPrompt {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  negative_prompt: string;
  created_at: number;
  updated_at: number;
}

export function listSavedPrompts(userId: string): SavedPrompt[] {
  return getDb()
    .query("SELECT * FROM dream_weaver_saved_prompts WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as SavedPrompt[];
}

export function getSavedPrompt(userId: string, id: string): SavedPrompt | null {
  const row = getDb()
    .query("SELECT * FROM dream_weaver_saved_prompts WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  return row ?? null;
}

export function createSavedPrompt(
  userId: string,
  input: { name: string; prompt: string; negative_prompt?: string }
): SavedPrompt {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO dream_weaver_saved_prompts
        (id, user_id, name, prompt, negative_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, input.name, input.prompt, input.negative_prompt ?? "", now, now);

  return getSavedPrompt(userId, id)!;
}

export function updateSavedPrompt(
  userId: string,
  id: string,
  input: { name?: string; prompt?: string; negative_prompt?: string }
): SavedPrompt | null {
  const existing = getSavedPrompt(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.prompt !== undefined) { fields.push("prompt = ?"); values.push(input.prompt); }
  if (input.negative_prompt !== undefined) { fields.push("negative_prompt = ?"); values.push(input.negative_prompt); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb()
    .query(`UPDATE dream_weaver_saved_prompts SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values);

  return getSavedPrompt(userId, id)!;
}

export function deleteSavedPrompt(userId: string, id: string): boolean {
  return (
    getDb()
      .query("DELETE FROM dream_weaver_saved_prompts WHERE id = ? AND user_id = ?")
      .run(id, userId).changes > 0
  );
}
