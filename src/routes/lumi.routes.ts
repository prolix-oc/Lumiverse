import { Hono } from "hono";
import * as lumiImportExportSvc from "../services/lumi/lumi-import-export.service";

const app = new Hono();

// import a .lumi file
app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const validation = lumiImportExportSvc.validateLumiFile(body);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const preset = lumiImportExportSvc.importLumiFile(userId, body);
  return c.json(preset, 201);
});

// export a lumi preset as .lumi
app.get("/export/:presetId", (c) => {
  const userId = c.get("userId");
  const presetId = c.req.param("presetId");

  const lumiFile = lumiImportExportSvc.exportLumiFile(userId, presetId);
  if (!lumiFile) {
    return c.json({ error: "Preset not found or not a Lumi engine preset" }, 404);
  }

  return c.json(lumiFile);
});

export { app as lumiRoutes };
