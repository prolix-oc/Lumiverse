import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { domainToASCII } from "node:url";

const MAX_TLS_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TLS_CERTIFICATES = 128;
const MAX_SNI_NAMES = 256;
const CERTIFICATE_PEM_MARKER = "-----BEGIN CERTIFICATE-----";
const PRIVATE_KEY_PEM_PATTERN = /-----BEGIN (?:ENCRYPTED )?(?:RSA |EC )?PRIVATE KEY-----/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface TlsEnvironment {
  [key: string]: string | undefined;
  LUMIVERSE_TLS_CERT_FILE?: string;
  LUMIVERSE_TLS_KEY_FILE?: string;
  LUMIVERSE_TLS_KEY_PASSPHRASE_FILE?: string;
  LUMIVERSE_TLS_CONFIG_FILE?: string;
}

interface TlsCertificateManifestEntry {
  certFile: string;
  keyFile: string;
  serverNames?: string[];
  keyPassphraseFile?: string;
}

interface TlsManifest {
  certificates: TlsCertificateManifestEntry[];
}

export interface LoadedTlsConfig {
  options: Bun.TLSOptions | Bun.TLSOptions[];
  certificateCount: number;
  serverNames: string[];
  source: string;
}

interface LoadedCertificate {
  tls: Bun.TLSOptions;
  serverNames: string[];
}

function tlsError(message: string): Error {
  return new Error(`[TLS] ${message}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw tlsError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function resolveFilePath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function readBoundedFile(path: string, label: string): Buffer {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw tlsError(`Cannot read ${label} at "${path}"${detail}`);
  }
  if (!stat.isFile()) {
    throw tlsError(`${label} must be a regular file: "${path}"`);
  }
  if (stat.size === 0) {
    throw tlsError(`${label} is empty: "${path}"`);
  }
  if (stat.size > MAX_TLS_FILE_BYTES) {
    throw tlsError(`${label} exceeds ${MAX_TLS_FILE_BYTES} bytes: "${path}"`);
  }
  try {
    return readFileSync(path);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw tlsError(`Cannot read ${label} at "${path}"${detail}`);
  }
}

function readPassphrase(path: string): string {
  const value = readBoundedFile(path, "TLS key passphrase file")
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (!value) {
    throw tlsError(`TLS key passphrase file is empty: "${path}"`);
  }
  if (value.includes("\0")) {
    throw tlsError(`TLS key passphrase file contains a NUL byte: "${path}"`);
  }
  return value;
}

function normalizeServerName(value: unknown, label: string): string {
  const input = nonEmptyString(value, label).replace(/\.$/, "");
  if (input.includes("*")) {
    throw tlsError(`${label} must be an exact SNI hostname, not a wildcard`);
  }
  const ascii = domainToASCII(input).toLowerCase();
  if (!ascii || ascii.length > 253 || isIP(ascii) !== 0) {
    throw tlsError(`${label} must be a DNS hostname (IP clients do not send SNI)`);
  }
  const labels = ascii.split(".");
  if (labels.some((part) => !DNS_LABEL_PATTERN.test(part))) {
    throw tlsError(`${label} is not a valid DNS hostname: "${input}"`);
  }
  return ascii;
}

function parseServerNames(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw tlsError(`${label} must be a non-empty array when provided`);
  }
  return value.map((name, index) => normalizeServerName(name, `${label}[${index}]`));
}

function assertManifestEntry(value: unknown, index: number): TlsCertificateManifestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw tlsError(`certificates[${index}] must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const allowed = new Set(["certFile", "keyFile", "serverNames", "keyPassphraseFile"]);
  const unknownKeys = Object.keys(entry).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw tlsError(`certificates[${index}] contains unknown field(s): ${unknownKeys.join(", ")}`);
  }
  return {
    certFile: nonEmptyString(entry.certFile, `certificates[${index}].certFile`),
    keyFile: nonEmptyString(entry.keyFile, `certificates[${index}].keyFile`),
    serverNames: parseServerNames(entry.serverNames, `certificates[${index}].serverNames`),
    ...(entry.keyPassphraseFile === undefined
      ? {}
      : {
          keyPassphraseFile: nonEmptyString(
            entry.keyPassphraseFile,
            `certificates[${index}].keyPassphraseFile`,
          ),
        }),
  };
}

function parseManifest(contents: Buffer, path: string): TlsManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw tlsError(`Invalid JSON in TLS config file "${path}"${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw tlsError(`TLS config file "${path}" must contain an object`);
  }
  const record = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "certificates");
  if (unknownKeys.length > 0) {
    throw tlsError(`TLS config file contains unknown field(s): ${unknownKeys.join(", ")}`);
  }
  if (!Array.isArray(record.certificates) || record.certificates.length === 0) {
    throw tlsError(`TLS config file must contain a non-empty certificates array`);
  }
  if (record.certificates.length > MAX_TLS_CERTIFICATES) {
    throw tlsError(`TLS config file supports at most ${MAX_TLS_CERTIFICATES} certificates`);
  }
  return { certificates: record.certificates.map(assertManifestEntry) };
}

function loadCertificate(
  entry: TlsCertificateManifestEntry,
  baseDir: string,
  label: string,
): LoadedCertificate {
  const certPath = resolveFilePath(entry.certFile, baseDir);
  const keyPath = resolveFilePath(entry.keyFile, baseDir);
  const passphrasePath = entry.keyPassphraseFile
    ? resolveFilePath(entry.keyPassphraseFile, baseDir)
    : undefined;
  const cert = readBoundedFile(certPath, `${label} certificate`);
  const key = readBoundedFile(keyPath, `${label} private key`);

  if (!cert.includes(CERTIFICATE_PEM_MARKER)) {
    throw tlsError(`${label} certificate is not a PEM certificate: "${certPath}"`);
  }
  if (!PRIVATE_KEY_PEM_PATTERN.test(key.toString("utf8"))) {
    throw tlsError(`${label} private key is not a supported PEM private key: "${keyPath}"`);
  }

  const passphrase = passphrasePath ? readPassphrase(passphrasePath) : undefined;
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(cert);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw tlsError(`${label} certificate could not be parsed${detail}`);
  }
  try {
    const privateKey = createPrivateKey({ key, format: "pem", passphrase });
    if (!leaf.checkPrivateKey(privateKey)) {
      throw tlsError(`${label} certificate and private key do not match`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[TLS]")) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw tlsError(`${label} private key could not be parsed${detail}`);
  }

  const serverNames = entry.serverNames ?? [];
  for (const serverName of serverNames) {
    if (!leaf.checkHost(serverName, { subject: "never" })) {
      throw tlsError(
        `${label} certificate SAN does not cover configured SNI hostname "${serverName}"`,
      );
    }
  }

  return {
    tls: { cert, key, ...(passphrase === undefined ? {} : { passphrase }) },
    serverNames,
  };
}

function environmentValue(environment: TlsEnvironment, name: keyof TlsEnvironment): string | undefined {
  const value = environment[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Load optional direct-TLS settings for the Bun listener.
 *
 * A certificate/key pair is the simple path and serves one certificate whose
 * SAN may cover any number of hostnames. A manifest maps distinct certificates
 * to exact SNI hostnames. TLS is intentionally configured at Bun's listener,
 * before requests reach Hono.
 */
export function loadTlsConfig(
  environment: TlsEnvironment = process.env,
  workingDirectory = process.cwd(),
): LoadedTlsConfig | undefined {
  const certFile = environmentValue(environment, "LUMIVERSE_TLS_CERT_FILE");
  const keyFile = environmentValue(environment, "LUMIVERSE_TLS_KEY_FILE");
  const passphraseFile = environmentValue(environment, "LUMIVERSE_TLS_KEY_PASSPHRASE_FILE");
  const configFile = environmentValue(environment, "LUMIVERSE_TLS_CONFIG_FILE");
  const hasDirectSetting = certFile !== undefined || keyFile !== undefined || passphraseFile !== undefined;

  if (configFile && hasDirectSetting) {
    throw tlsError(
      "LUMIVERSE_TLS_CONFIG_FILE cannot be combined with LUMIVERSE_TLS_CERT_FILE, "
        + "LUMIVERSE_TLS_KEY_FILE, or LUMIVERSE_TLS_KEY_PASSPHRASE_FILE",
    );
  }
  if (!configFile && !hasDirectSetting) return undefined;

  if (configFile) {
    const manifestPath = resolveFilePath(configFile, workingDirectory);
    const manifest = parseManifest(readBoundedFile(manifestPath, "TLS config file"), manifestPath);
    const baseDir = dirname(manifestPath);
    const loaded = manifest.certificates.map((entry, index) =>
      loadCertificate(entry, baseDir, `certificates[${index}]`)
    );

    if (loaded.length > 1 && loaded.some((entry) => entry.serverNames.length === 0)) {
      throw tlsError("Every certificate must declare serverNames when the TLS config contains multiple certificates");
    }

    const names = loaded.flatMap((entry) => entry.serverNames);
    if (names.length > MAX_SNI_NAMES) {
      throw tlsError(`TLS config supports at most ${MAX_SNI_NAMES} SNI hostnames`);
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        throw tlsError(`SNI hostname "${name}" is assigned more than once`);
      }
      seen.add(name);
    }

    if (loaded.length === 1 && loaded[0]!.serverNames.length === 0) {
      return {
        options: loaded[0]!.tls,
        certificateCount: 1,
        serverNames: [],
        source: manifestPath,
      };
    }

    const options = loaded.flatMap((entry) =>
      entry.serverNames.map((serverName) => ({ ...entry.tls, serverName }))
    );
    return {
      options,
      certificateCount: loaded.length,
      serverNames: names,
      source: manifestPath,
    };
  }

  if (!certFile || !keyFile) {
    throw tlsError("LUMIVERSE_TLS_CERT_FILE and LUMIVERSE_TLS_KEY_FILE must be set together");
  }
  const loaded = loadCertificate(
    {
      certFile,
      keyFile,
      ...(passphraseFile ? { keyPassphraseFile: passphraseFile } : {}),
    },
    workingDirectory,
    "Direct TLS",
  );
  return {
    options: loaded.tls,
    certificateCount: 1,
    serverNames: [],
    source: "LUMIVERSE_TLS_CERT_FILE",
  };
}
