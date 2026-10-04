import { expect, test } from "bun:test";
import { restoreDesktopSession, type DesktopUpdateResume } from "../desktop/src/update-resume";

function fixture(options: { remote?: boolean; canStartServer?: boolean; autoStartServer?: boolean } = {}) {
  const calls: string[] = [];
  const preferences = { remote: false, canStartServer: true, autoStartServer: true, ...options };
  return {
    calls,
    preferences,
    restore: (resume: DesktopUpdateResume | null) => restoreDesktopSession(resume, preferences, {
      startServer: async (reopen) => { calls.push(`start:${reopen}`); },
      detectExternalServer: async () => { calls.push("detect-external"); },
      showFrontend: async () => { calls.push("show"); },
    }),
  };
}

test("normal launches retain auto-start and browser behavior", async () => {
  const enabled = fixture();
  await enabled.restore(null);
  expect(enabled.calls).toEqual(["start:true"]);
  const disabled = fixture({ autoStartServer: false });
  await disabled.restore(null);
  expect(disabled.calls).toEqual(["detect-external"]);
});

for (const resumeServer of [false, true]) {
  for (const reopenFrontend of [false, true]) {
    test(`update restores server=${resumeServer}, browser=${reopenFrontend} independently of auto-start`, async () => {
      for (const autoStartServer of [false, true]) {
        const f = fixture({ autoStartServer });
        await f.restore({ resumeServer, reopenFrontend });
        expect(f.calls).toEqual(resumeServer
          ? [`start:${reopenFrontend}`]
          : ["detect-external", ...(reopenFrontend ? ["show"] : [])]);
        expect(f.preferences.autoStartServer).toBe(autoStartServer);
      }
    });
  }
}

test("remote restoration never starts or probes a local server", async () => {
  const f = fixture({ remote: true });
  await f.restore({ resumeServer: true, reopenFrontend: true });
  expect(f.calls).toEqual(["show"]);
  f.calls.length = 0;
  await f.restore(null);
  expect(f.calls).toEqual([]);
});

test("missing local configuration still restores browser visibility without spawning", async () => {
  const f = fixture({ canStartServer: false });
  await f.restore({ resumeServer: true, reopenFrontend: true });
  expect(f.calls).toEqual(["detect-external", "show"]);
});

test("a later normal launch follows saved preferences, not the previous update override", async () => {
  const f = fixture({ autoStartServer: false });
  await f.restore({ resumeServer: true, reopenFrontend: false });
  await f.restore(null);
  expect(f.calls).toEqual(["start:false", "detect-external"]);
});

test("a failed server start does not open a browser before readiness", async () => {
  let shown = false;
  await expect(restoreDesktopSession({ resumeServer: true, reopenFrontend: true }, {
    remote: false, canStartServer: true, autoStartServer: false,
  }, {
    startServer: async () => { throw new Error("start failed"); },
    detectExternalServer: async () => {},
    showFrontend: async () => { shown = true; },
  })).rejects.toThrow("start failed");
  expect(shown).toBe(false);
});
