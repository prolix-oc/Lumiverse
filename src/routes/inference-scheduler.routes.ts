import { Hono } from "hono";

import * as inferenceScheduler from "../services/inference-scheduler";
import { discoverLocalInferenceEndpoints } from "../services/inference-scheduler/discovery";
import { InvalidSettingError } from "../services/settings-validation";

const app = new Hono();

function userId(c: { get: (key: "userId") => string }): string {
  return c.get("userId");
}

/** One call for the settings panel: config, live queues, and detected endpoints. */
app.get("/", async (c) => {
  const id = userId(c);
  return c.json({
    config: inferenceScheduler.getInferenceSchedulerConfig(id),
    status: inferenceScheduler.getInferenceSchedulerStatus(id),
    endpoints: await discoverLocalInferenceEndpoints(id),
  });
});

app.get("/config", (c) => {
  return c.json(inferenceScheduler.getInferenceSchedulerConfig(userId(c)));
});

app.put("/config", async (c) => {
  const id = userId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const config = inferenceScheduler.putInferenceSchedulerConfig(id, body);
    inferenceScheduler.invalidateInferenceSchedulerConfig(id);
    return c.json({
      config,
      status: inferenceScheduler.getInferenceSchedulerStatus(id),
      endpoints: await discoverLocalInferenceEndpoints(id),
    });
  } catch (err) {
    if (err instanceof InvalidSettingError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

app.get("/status", (c) => {
  const id = userId(c);
  return c.json({
    config: inferenceScheduler.getInferenceSchedulerConfig(id),
    status: inferenceScheduler.getInferenceSchedulerStatus(id),
  });
});

app.get("/endpoints", async (c) => {
  const id = userId(c);
  return c.json({
    endpoints: await discoverLocalInferenceEndpoints(id),
    config: inferenceScheduler.getInferenceSchedulerConfig(id),
  });
});

export { app as inferenceSchedulerRoutes };
