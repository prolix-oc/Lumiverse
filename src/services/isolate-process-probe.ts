import { runIsolateProcessEntrypoint } from "./isolate-process-entrypoint";

await runIsolateProcessEntrypoint({
  maxFrameBytes: 64 * 1024,
  handlers: {
    probe: async () => ({ ok: true }),
  },
});
