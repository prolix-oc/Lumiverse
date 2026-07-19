import { isTermuxLikeEnvironment } from "../utils/termux";

let resolvedFfmpegBinary: string | null | undefined;
let inflightResolution: Promise<string | null> | null = null;

interface ResolveFfmpegDeps {
  isTermuxLike?: () => boolean;
  canExecuteBinary?: (binary: string) => Promise<boolean>;
  loadStaticBinaryPath?: () => Promise<string | null>;
}

async function canExecuteBinary(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([binary, "-version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function loadStaticBinaryPath(): Promise<string | null> {
  try {
    const mod = await import("ffmpeg-static");
    const binary = mod.default;
    return typeof binary === "string" && binary.trim() ? binary : null;
  } catch {
    return null;
  }
}

async function resolveFfmpegBinaryUncached(deps: ResolveFfmpegDeps): Promise<string | null> {
  const termux = deps.isTermuxLike?.() ?? isTermuxLikeEnvironment();
  const probe = deps.canExecuteBinary ?? canExecuteBinary;
  const loadStatic = deps.loadStaticBinaryPath ?? loadStaticBinaryPath;

  if (await probe("ffmpeg")) return "ffmpeg";
  if (termux) return null;

  const staticBinary = await loadStatic();
  if (!staticBinary) return null;
  return (await probe(staticBinary)) ? staticBinary : null;
}

export async function resolveFfmpegBinary(deps?: ResolveFfmpegDeps): Promise<string | null> {
  if (deps?.isTermuxLike || deps?.canExecuteBinary || deps?.loadStaticBinaryPath) {
    return resolveFfmpegBinaryUncached(deps);
  }
  if (resolvedFfmpegBinary !== undefined) return resolvedFfmpegBinary;
  if (inflightResolution) return inflightResolution;

  inflightResolution = resolveFfmpegBinaryUncached({})
    .then((binary) => {
      resolvedFfmpegBinary = binary;
      return binary;
    })
    .finally(() => {
      inflightResolution = null;
    });

  return inflightResolution;
}

export async function isFfmpegBinaryAvailable(): Promise<boolean> {
  return (await resolveFfmpegBinary()) !== null;
}

export function resetFfmpegBinaryResolution(): void {
  resolvedFfmpegBinary = undefined;
  inflightResolution = null;
}
