import { expect, test } from "bun:test";
import { join } from "path";

import { PROJECT_ROOT } from "./lib/constants";
import { launchServerProcess } from "./server-process-launcher";
import { forwardServerOutput } from "./server-process-output";
import { backendBunCommand, serverLaunchTransport } from "./server-manager";

test("the backend launcher avoids Bun IPC only on Windows", () => {
  expect(serverLaunchTransport("win32")).toBe("socket");
  expect(serverLaunchTransport("darwin")).toBe("ipc");
  expect(serverLaunchTransport("linux")).toBe("ipc");
});

test("the backend launcher preserves the native Termux Bun wrapper", () => {
  const bunPath = "/data/data/com.termux/files/home/.bun/bin/bun";
  expect(backendBunCommand(["--smol", "/repo/src/index.ts"], {
    LUMIVERSE_BUN_METHOD: "grun",
    LUMIVERSE_BUN_PATH: bunPath,
    LUMIVERSE_BUN_EXECUTABLE: bunPath,
  })).toEqual(["grun", bunPath, "--smol", "/repo/src/index.ts"]);
});

test("the backend launcher keeps the validated executable outside Termux", () => {
  expect(backendBunCommand(["--smol", "C:\\repo\\src\\index.ts"], {
    LUMIVERSE_BUN_EXECUTABLE: "C:\\Lumiverse\\runtimes\\bun.exe",
  })).toEqual([
    "C:\\Lumiverse\\runtimes\\bun.exe",
    "--smol",
    "C:\\repo\\src\\index.ts",
  ]);
});

test("the socket-controlled spawn exchanges messages with a real backend process", async () => {
  const ready = Promise.withResolvers<{ type: string; pid: number }>();
  const pong = Promise.withResolvers<{ type: string; value: string }>();
  const disconnected = Promise.withResolvers<void>();
  const errors: string[] = [];
  let launched: ReturnType<typeof launchServerProcess> | null = null;
  let exited = false;

  try {
    let forwardedChunks = 0;
    launched = launchServerProcess({
      transport: "socket",
      cmd: [
        process.execPath,
        join(PROJECT_ROOT, "scripts", "runner", "fixtures", "runner-control-child.ts"),
      ],
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      onMessage(message) {
        const received = message as { type?: unknown; pid?: unknown; value?: unknown };
        if (received.type === "ready") ready.resolve(received as { type: string; pid: number });
        if (received.type === "pong") pong.resolve(received as { type: string; value: string });
      },
      onControlError(message) {
        errors.push(message);
      },
      onControlDisconnect() {
        disconnected.resolve();
      },
      writeOutput() {
        forwardedChunks += 1;
      },
    });

    // Regression: the same launcher boundary used by startServer must resolve
    // inherited output without calling getReader() on Bun's fd values.
    await launched.outputDone;
    expect(forwardedChunks).toBe(0);

    const readyMessage = await Promise.race([
      ready.promise,
      Bun.sleep(5_000).then(() => { throw new Error("Child ready message timed out"); }),
    ]);
    expect(readyMessage.pid).toBe(launched.proc.pid);

    expect(launched.control.send({ type: "ping", value: "windows-spawn" })).toBe(true);
    expect(await Promise.race([
      pong.promise,
      Bun.sleep(5_000).then(() => { throw new Error("Child pong message timed out"); }),
    ])).toEqual({ type: "pong", value: "windows-spawn" });

    expect(launched.control.send({ type: "shutdown" })).toBe(true);
    expect(await Promise.race([
      launched.proc.exited,
      Bun.sleep(5_000).then(() => { throw new Error("Child shutdown timed out"); }),
    ])).toBe(0);
    exited = true;
    await Promise.race([
      disconnected.promise,
      Bun.sleep(5_000).then(() => { throw new Error("Control disconnect timed out"); }),
    ]);
    expect(errors).toEqual([]);
  } finally {
    launched?.control.close();
    if (launched && !exited) {
      launched.proc.kill();
      await launched.proc.exited;
    }
  }
}, 15_000);

test("piped server output drains stdout and stderr through the declared writer", async () => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      'process.stdout.write("out"); process.stderr.write("err");',
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const received = { stdout: "", stderr: "" };
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  await Promise.all([
    forwardServerOutput(
      { kind: "piped", stdout: proc.stdout, stderr: proc.stderr },
      (chunk, stream) => {
        received[stream] += decoders[stream].decode(chunk, { stream: true });
      },
    ),
    proc.exited,
  ]);

  expect(received).toEqual({ stdout: "out", stderr: "err" });
});

test("piped server output keeps draining after its writer closes", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1));
      controller.enqueue(Uint8Array.of(2));
      controller.close();
    },
  });
  let writes = 0;

  await forwardServerOutput(
    { kind: "piped", stdout: stream, stderr: new ReadableStream({ start: (c) => c.close() }) },
    () => {
      writes += 1;
      throw new Error("log destination closed");
    },
  );

  expect(writes).toBe(1);
});

test("owned output pipes can be closed when descendants keep them alive", async () => {
  let cancellations = 0;
  const hangingStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    });
  const abort = new AbortController();
  const outputDone = forwardServerOutput(
    { kind: "piped", stdout: hangingStream(), stderr: hangingStream() },
    () => {},
    abort.signal,
  );

  abort.abort();
  await Promise.race([
    outputDone,
    Bun.sleep(1_000).then(() => {
      throw new Error("Output cancellation timed out");
    }),
  ]);

  expect(cancellations).toBe(2);
});
