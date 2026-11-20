import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTlsConfig } from "./tls-config";

// Test-only self-signed EC certificates. Their private keys protect no system
// and exist solely to exercise key matching, SAN validation, and Bun SNI.
const ONE_CERT = `-----BEGIN CERTIFICATE-----
MIIBvDCCAWKgAwIBAgIUIHDaQ5jY+GEGtyeOW1homE1f+AowCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQb25lLmV4YW1wbGUudGVzdDAeFw0yNjA5MTkxMDEwNTVaFw0z
NjA5MTYxMDEwNTVaMBsxGTAXBgNVBAMMEG9uZS5leGFtcGxlLnRlc3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAARLyHfqVNqf8SAivjm+wEzL8zzm43noK2oKEcuf
w9eiVCe0B52mD/QQBgtCLkL1X7IKPXUNqLxdb17BHOnaW4WKo4GDMIGAMB0GA1Ud
DgQWBBRvvD+XYL5YPBEw7S1VyIWtnwA5UzAfBgNVHSMEGDAWgBRvvD+XYL5YPBEw
7S1VyIWtnwA5UzAPBgNVHRMBAf8EBTADAQH/MC0GA1UdEQQmMCSCEG9uZS5leGFt
cGxlLnRlc3SCEGFsdC5leGFtcGxlLnRlc3QwCgYIKoZIzj0EAwIDSAAwRQIhAKao
YylfcyPm8h2kz8dd/dD7wx+UNg9p/bWwsNtoPlIUAiBpQpFOXBr8cgvfSrJunc0E
Zd2hXDnJ0+jfCa/4J6BfZA==
-----END CERTIFICATE-----
`;

const ONE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBxb7C6lxCJcuHYcf
3pUxkzYeRTkz3dFuNRgpS2RycgihRANCAARLyHfqVNqf8SAivjm+wEzL8zzm43no
K2oKEcufw9eiVCe0B52mD/QQBgtCLkL1X7IKPXUNqLxdb17BHOnaW4WK
-----END PRIVATE KEY-----
`;

const TWO_CERT = `-----BEGIN CERTIFICATE-----
MIIBpzCCAU6gAwIBAgIUCFhmogx1luKS7BJBce38pJFoibEwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQdHdvLmV4YW1wbGUudGVzdDAeFw0yNjA5MTkxMDEwNTVaFw0z
NjA5MTYxMDEwNTVaMBsxGTAXBgNVBAMMEHR3by5leGFtcGxlLnRlc3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAASLiYQAVOJrzHofjxINjdwkWSoeMAekfA8pdG8I
+BDPGYDgF3cHn3fJm7oMq88kK23CLg2cAGbp0Ve9TwE+6xNvo3AwbjAdBgNVHQ4E
FgQUZA6Zg0bJK9rm0KVxiNuUpJPxFikwHwYDVR0jBBgwFoAUZA6Zg0bJK9rm0KVx
iNuUpJPxFikwDwYDVR0TAQH/BAUwAwEB/zAbBgNVHREEFDASghB0d28uZXhhbXBs
ZS50ZXN0MAoGCCqGSM49BAMCA0cAMEQCIGeLYuF7a0A9ZWzkS6RquyDl94kFioaW
9wFOLwHV3NbpAiBPVXNiyoLSLFaAHFzEFG6B09uUUFCLGOyXqPKeHjxEDg==
-----END CERTIFICATE-----
`;

const TWO_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgADoWu7+TLsR/N074
kvSyPOD9R1rm5hCz3y9lz4ujzx2hRANCAASLiYQAVOJrzHofjxINjdwkWSoeMAek
fA8pdG8I+BDPGYDgF3cHn3fJm7oMq88kK23CLg2cAGbp0Ve9TwE+6xNv
-----END PRIVATE KEY-----
`;

let workDir: string | undefined;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function fixtureDirectory(): string {
  workDir = mkdtempSync(join(tmpdir(), "lumiverse-tls-config-"));
  writeFileSync(join(workDir, "one.crt"), ONE_CERT);
  writeFileSync(join(workDir, "one.key"), ONE_KEY, { mode: 0o600 });
  writeFileSync(join(workDir, "two.crt"), TWO_CERT);
  writeFileSync(join(workDir, "two.key"), TWO_KEY, { mode: 0o600 });
  return workDir;
}

function writeManifest(directory: string, manifest: unknown): string {
  const configDirectory = join(directory, "config");
  mkdirSync(configDirectory);
  const path = join(configDirectory, "tls.json");
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

function startTlsServer(options: Bun.TLSOptions | Bun.TLSOptions[]): Bun.Server<undefined> {
  // bun-types 1.4.2 has not exposed the runtime's new `http2` option yet, so
  // keep it in a spread just like the production server configuration.
  const tlsTransport = { tls: options, http2: true };
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...tlsTransport,
    fetch: () => new Response("secure"),
  });
}

async function getOverHttp2(
  port: number,
  serverName: string,
  ca: string,
): Promise<{ status: number; body: string }> {
  const client = connect(`https://127.0.0.1:${port}`, { ca, servername: serverName });
  try {
    return await new Promise((resolve, reject) => {
      let status = 0;
      let body = "";
      const request = client.request({ ":path": "/" });
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => resolve({ status, body }));
      request.on("error", reject);
      client.on("error", reject);
      request.end();
    });
  } finally {
    client.close();
  }
}

describe("loadTlsConfig", () => {
  test("leaves the Bun listener in HTTP mode when TLS is not configured", () => {
    expect(loadTlsConfig({}, "/unused")).toBeUndefined();
  });

  test("loads one default certificate whose SAN can cover multiple hosts", () => {
    const directory = fixtureDirectory();
    const result = loadTlsConfig({
      LUMIVERSE_TLS_CERT_FILE: "one.crt",
      LUMIVERSE_TLS_KEY_FILE: "one.key",
    }, directory);

    expect(result).toMatchObject({
      certificateCount: 1,
      serverNames: [],
      source: "LUMIVERSE_TLS_CERT_FILE",
    });
    const options = result!.options;
    expect(Array.isArray(options)).toBe(false);
    if (Array.isArray(options)) throw new Error("Expected one default TLS configuration");
    expect(options.cert).toBeInstanceOf(Buffer);
    expect(options.key).toBeInstanceOf(Buffer);
  });

  test("serves a SAN certificate through Bun's HTTP/2 TLS listener", async () => {
    const directory = fixtureDirectory();
    const result = loadTlsConfig({
      LUMIVERSE_TLS_CERT_FILE: "one.crt",
      LUMIVERSE_TLS_KEY_FILE: "one.key",
    }, directory)!;
    const server = startTlsServer(result.options);
    try {
      expect(await getOverHttp2(server.port!, "alt.example.test", ONE_CERT)).toEqual({
        status: 200,
        body: "secure",
      });
    } finally {
      server.stop(true);
    }
  });

  test("loads an encrypted key passphrase from a file without placing it in the manifest", () => {
    const directory = fixtureDirectory();
    const passphrase = "test-only passphrase";
    const encryptedKey = createPrivateKey(ONE_KEY).export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase,
    });
    writeFileSync(join(directory, "encrypted.key"), encryptedKey, { mode: 0o600 });
    writeFileSync(join(directory, "passphrase"), `${passphrase}\n`, { mode: 0o600 });

    const result = loadTlsConfig({
      LUMIVERSE_TLS_CERT_FILE: "one.crt",
      LUMIVERSE_TLS_KEY_FILE: "encrypted.key",
      LUMIVERSE_TLS_KEY_PASSPHRASE_FILE: "passphrase",
    }, directory)!;
    if (Array.isArray(result.options)) throw new Error("Expected one default TLS configuration");
    expect(result.options.passphrase).toBe(passphrase);
  });

  test("expands manifest entries into Bun SNI configurations using manifest-relative paths", () => {
    const directory = fixtureDirectory();
    const manifestPath = writeManifest(directory, {
      certificates: [
        {
          certFile: "../one.crt",
          keyFile: "../one.key",
          serverNames: ["ONE.example.test.", "alt.example.test"],
        },
        {
          certFile: "../two.crt",
          keyFile: "../two.key",
          serverNames: ["two.example.test"],
        },
      ],
    });

    const result = loadTlsConfig({ LUMIVERSE_TLS_CONFIG_FILE: manifestPath }, "/unused");
    expect(result).toMatchObject({
      certificateCount: 2,
      serverNames: ["one.example.test", "alt.example.test", "two.example.test"],
      source: manifestPath,
    });
    expect(Array.isArray(result!.options)).toBe(true);
    expect((result!.options as Bun.TLSOptions[]).map((entry) => entry.serverName)).toEqual([
      "one.example.test",
      "alt.example.test",
      "two.example.test",
    ]);
  });

  test("selects distinct manifest certificates by SNI", async () => {
    const directory = fixtureDirectory();
    const manifestPath = writeManifest(directory, {
      certificates: [
        {
          certFile: "../one.crt",
          keyFile: "../one.key",
          serverNames: ["one.example.test"],
        },
        {
          certFile: "../two.crt",
          keyFile: "../two.key",
          serverNames: ["two.example.test"],
        },
      ],
    });
    const result = loadTlsConfig({ LUMIVERSE_TLS_CONFIG_FILE: manifestPath })!;
    const server = startTlsServer(result.options);
    try {
      for (const [serverName, ca] of [
        ["one.example.test", ONE_CERT],
        ["two.example.test", TWO_CERT],
      ] as const) {
        const response = await fetch(`https://127.0.0.1:${server.port}/`, {
          tls: { ca, serverName },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("secure");
      }
    } finally {
      server.stop(true);
    }
  });

  test("rejects partial or conflicting environment configuration", () => {
    expect(() => loadTlsConfig({ LUMIVERSE_TLS_CERT_FILE: "one.crt" }, "/unused"))
      .toThrow("LUMIVERSE_TLS_CERT_FILE and LUMIVERSE_TLS_KEY_FILE must be set together");
    expect(() => loadTlsConfig({
      LUMIVERSE_TLS_CONFIG_FILE: "tls.json",
      LUMIVERSE_TLS_CERT_FILE: "one.crt",
      LUMIVERSE_TLS_KEY_FILE: "one.key",
    }, "/unused")).toThrow("cannot be combined");
  });

  test("rejects a certificate and private key that do not match", () => {
    const directory = fixtureDirectory();
    expect(() => loadTlsConfig({
      LUMIVERSE_TLS_CERT_FILE: "one.crt",
      LUMIVERSE_TLS_KEY_FILE: "two.key",
    }, directory)).toThrow("certificate and private key do not match");
  });

  test("rejects an SNI hostname that is not covered by the certificate SAN", () => {
    const directory = fixtureDirectory();
    const manifestPath = writeManifest(directory, {
      certificates: [{
        certFile: "../one.crt",
        keyFile: "../one.key",
        serverNames: ["missing.example.test"],
      }],
    });
    expect(() => loadTlsConfig({ LUMIVERSE_TLS_CONFIG_FILE: manifestPath }))
      .toThrow('certificate SAN does not cover configured SNI hostname "missing.example.test"');
  });

  test("rejects duplicate SNI mappings and unnamed certificates in a multi-certificate manifest", () => {
    const directory = fixtureDirectory();
    const duplicatePath = writeManifest(directory, {
      certificates: [
        { certFile: "../one.crt", keyFile: "../one.key", serverNames: ["one.example.test"] },
        { certFile: "../one.crt", keyFile: "../one.key", serverNames: ["ONE.EXAMPLE.TEST"] },
      ],
    });
    expect(() => loadTlsConfig({ LUMIVERSE_TLS_CONFIG_FILE: duplicatePath }))
      .toThrow('SNI hostname "one.example.test" is assigned more than once');

    rmSync(join(directory, "config"), { recursive: true, force: true });
    const unnamedPath = writeManifest(directory, {
      certificates: [
        { certFile: "../one.crt", keyFile: "../one.key" },
        { certFile: "../two.crt", keyFile: "../two.key", serverNames: ["two.example.test"] },
      ],
    });
    expect(() => loadTlsConfig({ LUMIVERSE_TLS_CONFIG_FILE: unnamedPath }))
      .toThrow("Every certificate must declare serverNames");
  });
});
