import { Hono } from "hono";
import {
  authenticateDesktopDestinationCredential,
  getDesktopNotificationServerInstanceId,
} from "../services/push.service";
import { issueDesktopNotificationTicket } from "../ws/tickets";
import { rateLimit } from "../middleware/rate-limit";
import { authLockoutService } from "../services/auth-lockout.service";
import { getClientIp } from "../utils/client-ip";

const app = new Hono();
const ticketLimiter = rateLimit({
  bucket: "desktop-notification-ticket",
  max: 120,
  windowMs: 60 * 1000,
  message: "Too many desktop notification ticket requests. Try again shortly.",
});
const mediaLimiter = rateLimit({
  bucket: "desktop-notification-media",
  max: 240,
  windowMs: 60 * 1000,
  message: "Too many desktop notification media requests. Try again shortly.",
});

type DesktopNotificationMediaTarget = {
  kind: "character_avatar" | "image";
  id: string;
  size?: "sm" | "lg";
};

export function parseDesktopNotificationMediaPath(
  rawPath: string | undefined,
): DesktopNotificationMediaTarget | null {
  if (
    !rawPath
    || rawPath.length > 2_048
    || !rawPath.startsWith("/")
    || rawPath.startsWith("//")
    || rawPath.includes("\\")
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawPath, "https://desktop-notification.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://desktop-notification.invalid" || parsed.hash) return null;
  if ([...parsed.searchParams.keys()].some((key) => key !== "size")) return null;
  if (parsed.searchParams.getAll("size").length > 1) return null;
  const sizeValue = parsed.searchParams.get("size");
  if (sizeValue !== null && sizeValue !== "sm" && sizeValue !== "lg") return null;
  const size = sizeValue === "sm" || sizeValue === "lg" ? sizeValue : undefined;

  const match = parsed.pathname.match(
    /^\/api\/v1\/(characters\/([^/]+)\/avatar|images\/([^/]+))\/?$/,
  );
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[2] ?? match[3] ?? "");
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return {
    kind: match[2] ? "character_avatar" : "image",
    id,
    ...(size ? { size } : {}),
  };
}

function authenticateDesktopRequest(c: any):
  | { destination: { userId: string; destinationId: string } }
  | { response: Response } {
  const authorization = c.req.header("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const destination = match
    ? authenticateDesktopDestinationCredential(match[1].trim())
    : null;
  if (destination) {
    authLockoutService.recordSuccess(getClientIp(c), "unauthorized");
    return { destination };
  }

  const clientId = getClientIp(c);
  const result = authLockoutService.recordFailure(clientId, "unauthorized", {
    method: c.req.method,
    path: c.req.path,
  });
  if (result.lockout) {
    c.header("Retry-After", String(Math.max(1, Math.ceil(result.lockout.retryAfterMs / 1000))));
    return {
      response: c.json(
        authLockoutService.buildPayload(
          result.lockout,
          "Too many invalid desktop notification credentials. Try again later.",
        ),
        429,
      ),
    };
  }
  return { response: c.json({ error: "Invalid desktop notification credential" }, 401) };
}

function desktopNotificationImageResponse(filepath: string): Response | null {
  const file = Bun.file(filepath);
  const contentType = file.type.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    return null;
  }
  return new Response(file, {
    headers: {
      "Cache-Control": "private, max-age=86400",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

app.get("/info", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ serverInstanceId: getDesktopNotificationServerInstanceId() });
});

app.post("/ticket", ticketLimiter, (c) => {
  c.header("Cache-Control", "no-store");
  const authentication = authenticateDesktopRequest(c);
  if ("response" in authentication) return authentication.response;
  const { destination } = authentication;

  return c.json({
    ticket: issueDesktopNotificationTicket(destination.userId, destination.destinationId),
  });
});

app.get("/media", mediaLimiter, async (c) => {
  const authentication = authenticateDesktopRequest(c);
  if ("response" in authentication) return authentication.response;
  const target = parseDesktopNotificationMediaPath(c.req.query("path"));
  if (!target) return c.json({ error: "Unsupported desktop notification media path" }, 400);

  const [characters, files, images] = await Promise.all([
    import("../services/characters.service"),
    import("../services/files.service"),
    import("../services/images.service"),
  ]);
  const userId = authentication.destination.userId;
  if (target.kind === "character_avatar") {
    const info = characters.getCharacterAvatarInfo(userId, target.id);
    if (!info) return c.json({ error: "Not found" }, 404);
    for (const imageId of [info.avatar_crop_image_id, info.image_id]) {
      if (!imageId) continue;
      const filepath = await images.getImageFilePath(userId, imageId, target.size);
      if (!filepath) continue;
      const response = desktopNotificationImageResponse(filepath);
      return response ?? c.json({ error: "Unsupported image format" }, 415);
    }
    if (info.avatar_path) {
      const filepath = await files.getAvatarPath(info.avatar_path);
      if (filepath) {
        const response = desktopNotificationImageResponse(filepath);
        return response ?? c.json({ error: "Unsupported image format" }, 415);
      }
    }
    return c.json({ error: "Not found" }, 404);
  }

  const image = await images.getImageAsync(userId, target.id);
  if (!image) return c.json({ error: "Not found" }, 404);
  const filepath = await images.getImageFilePath(userId, target.id, target.size);
  if (!filepath) return c.json({ error: "Not found" }, 404);
  const response = desktopNotificationImageResponse(filepath);
  return response ?? c.json({ error: "Unsupported image format" }, 415);
});

export { app as desktopNotificationTransportRoutes };
