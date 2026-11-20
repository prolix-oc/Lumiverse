import { expect, test } from "bun:test";
import { installDesktopRelease } from "../src/desktop-updates";

function fixture(options: { downloadFails?: boolean; installFails?: boolean; remote?: boolean } = {}) {
  const calls: string[] = [];
  const deps = {
    download: async () => { calls.push("verified-download"); if (options.downloadFails) throw new Error("Bad signature"); },
    captureResume: async () => { calls.push("capture-current-state"); return { resumeServer: !options.remote, reopenFrontend: false, localPort: options.remote ? undefined : 17860 }; },
    stop: async () => { calls.push("stop-owned-server"); },
    install: async (resume: { localPort?: number }) => { calls.push("install"); expect(resume.localPort).toBe(options.remote ? undefined : 17860); if (options.installFails) throw new Error("Cannot replace app"); },
    restore: async (resume: { reopenFrontend: boolean }) => { calls.push(`restore:${resume.reopenFrontend}`); },
  };
  return { calls, run: () => installDesktopRelease(deps) };
}
test("downloads and verifies before capturing state and stopping the local server", async () => {
  const f = fixture(); await f.run();
  expect(f.calls).toEqual(["verified-download", "capture-current-state", "stop-owned-server", "install"]);
});
test("a failed or untrusted download leaves the server running", async () => {
  const f = fixture({ downloadFails: true });
  await expect(f.run()).rejects.toThrow("Bad signature");
  expect(f.calls).toEqual(["verified-download"]);
});
test("a failed replacement resumes the owned server without showing a hidden browser", async () => {
  const f = fixture({ installFails: true });
  await expect(f.run()).rejects.toThrow("Cannot replace app");
  expect(f.calls.at(-1)).toBe("restore:false");
});
test("remote and externally owned servers are not started after a failed update", async () => {
  const f = fixture({ installFails: true, remote: true });
  await expect(f.run()).rejects.toThrow();
  expect(f.calls).not.toContain("restore:false");
});
