/**
 * Optional SMART monitoring through the system smartmontools installation.
 *
 * smartctl is deliberately an external, optional dependency: a backend must
 * remain usable on cloud VMs, containers, and platforms where block-device
 * pass-through is unavailable.  This module never invokes a shell and only
 * runs package-manager commands from a fixed allowlist.
 */
import { platform as getPlatform } from "node:os";
import { getDb } from "../db/connection";
import { spawnAsync, type SpawnAsyncResult } from "../spindle/spawn-async";
import { isTermuxLikeEnvironment } from "../utils/termux";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const PROBE_TIMEOUT_MS = 5_000;
const SMARTCTL_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1_000;
const SNAPSHOT_TTL_MS = 30 * 60 * 1_000;
const MONITOR_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const ALERT_REEMIT_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_DISCOVERED_DRIVES = 64;

export type SmartctlAvailability = "available" | "installable" | "manual" | "unsupported";
export type SmartDriveStatus = "ok" | "warning" | "failing" | "unavailable" | "standby";
export type SmartDriveKind = "ssd" | "hdd" | "unknown";
export type SmartAlertSeverity = "warning" | "failing";

export interface SmartDriveAlertCondition {
  severity: SmartAlertSeverity;
  message: string;
}

export interface SystemSmartAlertPayload {
  checkedAt: string;
  drives: Array<{
    device: string;
    model: string | null;
    status: SmartAlertSeverity;
    conditions: SmartDriveAlertCondition[];
  }>;
}

export interface SmartctlBinary {
  path: string;
  version: string | null;
}

export interface SmartctlInstallPlan {
  manager: "apt-get" | "dnf" | "yum" | "apk" | "pacman" | "zypper" | "brew" | "choco";
  command: string[];
  /** Whether the current process normally needs OS elevation to run this plan. */
  requiresElevation: boolean;
}

export interface SmartctlStatus {
  availability: SmartctlAvailability;
  binary: SmartctlBinary | null;
  installPlan: SmartctlInstallPlan | null;
  message: string;
  latestSnapshot: SmartctlSnapshot | null;
}

export interface SmartDriveSummary {
  device: string;
  protocol: string | null;
  kind: SmartDriveKind;
  model: string | null;
  serialNumber: string | null;
  status: SmartDriveStatus;
  temperatureC: number | null;
  exitStatus: number;
  percentageUsed: number | null;
  criticalWarning: number | null;
  ataAttributes: {
    reallocatedSectors: number | null;
    pendingSectors: number | null;
    uncorrectableSectors: number | null;
  };
  /** Specific SMART evidence behind warning/failing status, safe to show to an operator. */
  alertConditions: SmartDriveAlertCondition[];
  /** Present only when smartctl can identify the drive as solid-state. */
  ssd: {
    /** Manufacturer-reported endurance consumed, where the drive exposes it. */
    percentageUsed: number | null;
    /** Remaining endurance, derived from percentageUsed or an ATA lifetime field. */
    percentageRemaining: number | null;
    availableSparePercent: number | null;
    availableSpareThresholdPercent: number | null;
    dataWrittenBytes: number | null;
    powerOnHours: number | null;
    powerCycles: number | null;
    unsafeShutdowns: number | null;
    mediaErrors: number | null;
    wearLevelingCount: number | null;
    reservedBlocksUsed: number | null;
    programFailures: number | null;
    eraseFailures: number | null;
  } | null;
  /** Present only when smartctl reports a rotating drive. */
  hdd: {
    powerOnHours: number | null;
    powerCycles: number | null;
    startStopCount: number | null;
    loadCycleCount: number | null;
  } | null;
  message: string | null;
}

export interface SmartctlSnapshot {
  checkedAt: string;
  drives: SmartDriveSummary[];
  error: string | null;
}

export interface SmartctlInstallResult {
  installed: boolean;
  status: SmartctlStatus;
  error: string | null;
}

type Platform = ReturnType<typeof getPlatform>;
type Env = Record<string, string | undefined>;
type CommandRunner = (cmd: string[], options?: { timeoutMs?: number; ignoreStdout?: boolean }) => Promise<SpawnAsyncResult>;

interface SmartctlDependencies {
  platform?: Platform;
  env?: Env;
  isTermux?: boolean;
  run?: CommandRunner;
  now?: () => number;
}

let resolvedBinary: SmartctlBinary | null | undefined;
let resolvingBinary: Promise<SmartctlBinary | null> | null = null;
let latestSnapshot: SmartctlSnapshot | null = null;
let snapshotPromise: Promise<SmartctlSnapshot> | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let alertReemitTimer: ReturnType<typeof setInterval> | null = null;
let installationPromise: Promise<SmartctlInstallResult> | null = null;
let lastSmartWarningFingerprint: string | null = null;

function currentPlatform(deps: SmartctlDependencies): Platform {
  return deps.platform ?? getPlatform();
}

function currentEnv(deps: SmartctlDependencies): Env {
  return deps.env ?? process.env;
}

function runner(deps: SmartctlDependencies): CommandRunner {
  return deps.run ?? spawnAsync;
}

function isTermux(deps: SmartctlDependencies): boolean {
  return deps.isTermux ?? isTermuxLikeEnvironment();
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

/** Ordered candidates include common service-manager paths that are often absent from PATH. */
export function getSmartctlCandidates(deps: SmartctlDependencies = {}): string[] {
  const platform = currentPlatform(deps);
  const env = currentEnv(deps);
  const explicit = env.LUMIVERSE_SMARTCTL_PATH?.trim();

  if (platform === "win32") {
    return unique([
      explicit,
      "smartctl.exe",
      "smartctl",
      "C:\\Program Files\\smartmontools\\bin\\smartctl.exe",
      "C:\\Program Files (x86)\\smartmontools\\bin\\smartctl.exe",
    ]);
  }

  if (platform === "darwin") {
    return unique([
      explicit,
      "smartctl",
      "/opt/homebrew/bin/smartctl",
      "/usr/local/bin/smartctl",
      "/opt/local/sbin/smartctl",
      "/usr/sbin/smartctl",
    ]);
  }

  return unique([explicit, "smartctl", "/usr/sbin/smartctl", "/usr/bin/smartctl"]);
}

function extractVersion(output: string): string | null {
  return output.match(/smartctl\s+(\d+(?:\.\d+)+)/i)?.[1] ?? null;
}

async function probeBinary(candidate: string, deps: SmartctlDependencies): Promise<SmartctlBinary | null> {
  try {
    const result = await runner(deps)([candidate, "--version"], { timeoutMs: PROBE_TIMEOUT_MS });
    if (result.exitCode !== 0) return null;
    return { path: candidate, version: extractVersion(`${result.stdout}\n${result.stderr}`) };
  } catch {
    return null;
  }
}

async function resolveSmartctlBinaryUncached(deps: SmartctlDependencies): Promise<SmartctlBinary | null> {
  for (const candidate of getSmartctlCandidates(deps)) {
    const binary = await probeBinary(candidate, deps);
    if (binary) return binary;
  }
  return null;
}

export async function resolveSmartctlBinary(deps: SmartctlDependencies = {}): Promise<SmartctlBinary | null> {
  // Dependency injection makes tests deterministic and must not pollute the process-wide cache.
  if (Object.keys(deps).length > 0) return resolveSmartctlBinaryUncached(deps);
  if (resolvedBinary !== undefined) return resolvedBinary;
  if (resolvingBinary) return resolvingBinary;

  resolvingBinary = resolveSmartctlBinaryUncached({})
    .then((binary) => {
      resolvedBinary = binary;
      return binary;
    })
    .finally(() => {
      resolvingBinary = null;
    });
  return resolvingBinary;
}

export function resetSmartctlResolution(): void {
  resolvedBinary = undefined;
  resolvingBinary = null;
}

async function hasCommand(command: string, deps: SmartctlDependencies): Promise<boolean> {
  try {
    const result = await runner(deps)([command, "--version"], { timeoutMs: PROBE_TIMEOUT_MS, ignoreStdout: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Select an already-installed package manager.  Package names and arguments
 * are constants so this remains safe to expose behind an owner-only route.
 */
export async function getSmartctlInstallPlan(
  deps: SmartctlDependencies = {},
): Promise<SmartctlInstallPlan | null> {
  if (isTermux(deps)) return null;

  const platform = currentPlatform(deps);
  const candidates: SmartctlInstallPlan[] = platform === "linux"
    ? [
        { manager: "apt-get", command: ["apt-get", "install", "-y", "smartmontools"], requiresElevation: true },
        { manager: "dnf", command: ["dnf", "install", "-y", "smartmontools"], requiresElevation: true },
        { manager: "yum", command: ["yum", "install", "-y", "smartmontools"], requiresElevation: true },
        { manager: "apk", command: ["apk", "add", "--no-cache", "smartmontools"], requiresElevation: true },
        { manager: "pacman", command: ["pacman", "-S", "--noconfirm", "smartmontools"], requiresElevation: true },
        { manager: "zypper", command: ["zypper", "--non-interactive", "install", "smartmontools"], requiresElevation: true },
      ]
    : platform === "darwin"
      ? [{ manager: "brew", command: ["brew", "install", "smartmontools"], requiresElevation: false }]
      : platform === "win32"
        ? [{ manager: "choco", command: ["choco", "install", "smartmontools", "-y", "--no-progress"], requiresElevation: true }]
        : [];

  for (const candidate of candidates) {
    if (await hasCommand(candidate.manager, deps)) return candidate;
  }
  return null;
}

function isCurrentProcessElevated(platform: Platform): boolean {
  if (platform === "win32") return false; // Avoid guessing UAC state from a web backend.
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function manualInstallMessage(platform: Platform, termux: boolean): string {
  if (termux) return "SMART monitoring is unavailable on Termux by default because Android normally blocks raw disk access.";
  if (platform === "win32") return "Install Chocolatey, then install smartmontools, or use the official Windows installer.";
  if (platform === "darwin") return "Install Homebrew, then run: brew install smartmontools";
  if (platform === "linux") return "Install the smartmontools package with this system's package manager.";
  return "Install smartmontools from your operating system's package repository.";
}

export async function getSmartctlStatus(deps: SmartctlDependencies = {}): Promise<SmartctlStatus> {
  const binary = await resolveSmartctlBinary(deps);
  if (binary) {
    return {
      availability: "available",
      binary,
      installPlan: null,
      message: "smartctl is available.",
      latestSnapshot,
    };
  }

  const plan = await getSmartctlInstallPlan(deps);
  const platform = currentPlatform(deps);
  const termux = isTermux(deps);
  return {
    availability: termux ? "unsupported" : plan ? "installable" : "manual",
    binary: null,
    installPlan: plan,
    message: plan
      ? `smartctl is not installed. It can be installed with ${plan.manager}.`
      : manualInstallMessage(platform, termux),
    latestSnapshot,
  };
}

/**
 * Runs an available fixed install plan only when the server process already
 * has the required privilege. It never runs sudo, opens UAC, or accepts a
 * password. The CLI installer is responsible for interactive elevation.
 */
export async function installSmartctl(): Promise<SmartctlInstallResult> {
  if (installationPromise) return installationPromise;

  installationPromise = (async () => {
    const before = await getSmartctlStatus();
    if (before.binary) return { installed: false, status: before, error: null };
    if (!before.installPlan) return { installed: false, status: before, error: before.message };

    const platform = getPlatform();
    if (before.installPlan.requiresElevation && !isCurrentProcessElevated(platform)) {
      return {
        installed: false,
        status: before,
        error: "Installation requires an elevated local terminal. The API will not prompt for administrator credentials.",
      };
    }

    const result = await spawnAsync(before.installPlan.command, { timeoutMs: INSTALL_TIMEOUT_MS });
    resetSmartctlResolution();
    const status = await getSmartctlStatus();
    if (status.binary) return { installed: true, status, error: null };

    return {
      installed: false,
      status,
      error: result.timedOut
        ? "smartmontools installation timed out."
        : result.stderr.trim() || `Package manager exited with status ${result.exitCode}.`,
    };
  })().finally(() => {
    installationPromise = null;
  });

  return installationPromise;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^-?\d+(?:\.\d+)?$/.test(normalized) && Number.isFinite(Number(normalized))
    ? Number(normalized)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ataAttributeEntry(report: Record<string, any>, id: number, names: string[] = []): Record<string, any> | null {
  const table = report.ata_smart_attributes?.table;
  if (!Array.isArray(table)) return null;
  return table.find((attribute: any) => attribute?.id === id)
    ?? table.find((attribute: any) => names.includes(attribute?.name));
}

function ataAttribute(report: Record<string, any>, id: number, names: string[] = []): number | null {
  const entry = ataAttributeEntry(report, id, names);
  return numberOrNull(entry?.raw?.value) ?? numberOrNull(entry?.raw?.string ? Number(entry.raw.string) : null);
}

function firstValue(values: Array<number | null>): number | null {
  return values.find((value): value is number => value != null) ?? null;
}

function ataAttributeByName(report: Record<string, any>, pattern: RegExp): Record<string, any> | null {
  const table = report.ata_smart_attributes?.table;
  if (!Array.isArray(table)) return null;
  return table.find((attribute: any) => typeof attribute?.name === "string" && pattern.test(attribute.name)) ?? null;
}

function boundedPercent(value: number | null): number | null {
  return value != null && value >= 0 && value <= 100 ? value : null;
}

function dataUnitsToBytes(value: number | null, unitBytes: number): number | null {
  if (value == null || value < 0) return null;
  const bytes = value * unitBytes;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function driveKind(report: Record<string, any> | null, nvme: Record<string, any> | null): SmartDriveKind {
  if (nvme || /^nvme$/i.test(stringOrNull(report?.device?.protocol) ?? "")) return "ssd";

  const rotationRate = numberOrNull(report?.rotation_rate);
  if (rotationRate === 0) return "ssd";
  if (rotationRate != null && rotationRate > 0) return "hdd";

  // ATA attributes are largely vendor-defined. These names are a stronger
  // signal than a model-name guess and include the common SATA SSD variants.
  const ssdAttribute = ataAttributeByName(
    report ?? {},
    /(?:nand|wear[_ -]?level|lifetime|life[_ -]?(?:left|remain)|media[_ -]?wear|reserve(?:d)?[_ -]?(?:blk|block)|program[_ -]?fail|erase[_ -]?fail)/i,
  );
  return ssdAttribute ? "ssd" : "unknown";
}

function ataLifetimeUsed(report: Record<string, any>): number | null {
  const entry = ataAttributeByName(report, /(?:percent|percentage)[_ -]?(?:lifetime|life)[_ -]?used/i);
  return boundedPercent(numberOrNull(entry?.raw?.value) ?? numberOrNull(entry?.raw?.string) ?? numberOrNull(entry?.value));
}

function ataLifetimeRemaining(report: Record<string, any>): number | null {
  const entry = ataAttributeByName(
    report,
    /(?:ssd[_ -]?life[_ -]?left|(?:percent|percentage)[_ -]?(?:lifetime|life)[_ -]?(?:remain|left)|media[_ -]?wearout[_ -]?indicator|remaining[_ -]?(?:lifetime|life))/i,
  );
  // The normalized VALUE is the vendor's health percentage for these fields;
  // the RAW value often holds unrelated per-chip / min-max details.
  return boundedPercent(numberOrNull(entry?.value) ?? numberOrNull(entry?.raw?.value));
}

function createSsdMetrics(report: Record<string, any>, nvme: Record<string, any> | null) {
  const nvmePercentageUsed = numberOrNull(nvme?.percentage_used);
  const ataPercentageUsed = ataLifetimeUsed(report);
  const percentageUsed = nvmePercentageUsed ?? ataPercentageUsed;
  const ataPercentageRemaining = ataLifetimeRemaining(report);
  const powerOnHours = numberOrNull(nvme?.power_on_hours)
    ?? numberOrNull(report.power_on_time?.hours)
    ?? ataAttribute(report, 9, ["Power_On_Hours"]);
  const powerCycles = numberOrNull(nvme?.power_cycles)
    ?? numberOrNull(report.power_cycle_count)
    ?? ataAttribute(report, 12, ["Power_Cycle_Count"]);
  const ataLbasWritten = ataAttribute(report, 241, ["Total_LBAs_Written"]);
  const logicalBlockSize = numberOrNull(report.logical_block_size) ?? 512;

  return {
    percentageUsed,
    percentageRemaining: percentageUsed != null
      ? Math.max(0, 100 - percentageUsed)
      : ataPercentageRemaining,
    availableSparePercent: numberOrNull(nvme?.available_spare),
    availableSpareThresholdPercent: numberOrNull(nvme?.available_spare_threshold),
    // NVMe defines a data unit as 512,000 bytes. ATA's Total_LBAs_Written is
    // vendor-specific but conventionally counts logical LBAs, so use the
    // reported logical block size when available.
    dataWrittenBytes: nvme
      ? dataUnitsToBytes(numberOrNull(nvme.data_units_written), 512_000)
      : dataUnitsToBytes(ataLbasWritten, logicalBlockSize),
    powerOnHours,
    powerCycles,
    unsafeShutdowns: numberOrNull(nvme?.unsafe_shutdowns)
      ?? ataAttribute(report, 174, ["Unexpected_Power_Loss_Ct", "Unsafe_Shutdown_Count"]),
    mediaErrors: numberOrNull(nvme?.media_and_data_integrity_errors)
      ?? ataAttribute(report, 187, ["Reported_Uncorrect"]),
    wearLevelingCount: ataAttribute(report, 177, ["Wear_Leveling_Count"])
      ?? ataAttribute(report, 173, ["Wear_Leveling_Count"]),
    reservedBlocksUsed: firstValue([
      ataAttribute(report, 179, ["Used_Rsvd_Blk_Cnt_Tot"]),
      ataAttribute(report, 178, ["Used_Rsvd_Blk_Cnt_Chip"]),
    ]),
    programFailures: firstValue([
      ataAttribute(report, 181, ["Program_Fail_Cnt_Total"]),
      ataAttribute(report, 171, ["Program_Fail_Count"]),
      ataAttribute(report, 175, ["Program_Fail_Count_Chip"]),
    ]),
    eraseFailures: firstValue([
      ataAttribute(report, 182, ["Erase_Fail_Cnt_Total"]),
      ataAttribute(report, 172, ["Erase_Fail_Count"]),
      ataAttribute(report, 176, ["Erase_Fail_Count_Chip"]),
    ]),
  };
}

function createHddMetrics(report: Record<string, any>) {
  return {
    powerOnHours: numberOrNull(report.power_on_time?.hours)
      ?? ataAttribute(report, 9, ["Power_On_Hours"]),
    powerCycles: numberOrNull(report.power_cycle_count)
      ?? ataAttribute(report, 12, ["Power_Cycle_Count"]),
    startStopCount: ataAttribute(report, 4, ["Start_Stop_Count"]),
    loadCycleCount: ataAttribute(report, 193, ["Load_Cycle_Count"]),
  };
}

function ataAttributeName(attribute: Record<string, any>): string {
  return stringOrNull(attribute.name)?.replace(/_/g, " ")
    ?? (numberOrNull(attribute.id) != null ? `SMART attribute ${attribute.id}` : "SMART attribute");
}

/**
 * smartctl's status bitmask is helpful for classification but not for an
 * operator trying to act. Turn the specific evidence into short, safe text
 * for the Operator panel and the startup/periodic alert.
 */
function collectSmartAlertConditions(
  report: Record<string, any> | null,
  exitStatus: number,
  criticalWarning: number | null,
  ssd: ReturnType<typeof createSsdMetrics> | null,
): SmartDriveAlertCondition[] {
  const conditions: SmartDriveAlertCondition[] = [];
  const seen = new Set<string>();
  const add = (severity: SmartAlertSeverity, message: string): void => {
    if (!seen.has(message)) {
      seen.add(message);
      conditions.push({ severity, message });
    }
  };

  if (report?.smart_status?.passed === false || (exitStatus & 0b00001000) !== 0) {
    add("failing", "SMART overall-health check reports the drive is failing.");
  }

  let reportedPreFailNow = false;
  let reportedPreFailPast = false;
  const table = report?.ata_smart_attributes?.table;
  if (Array.isArray(table)) {
    for (const attribute of table) {
      const type = stringOrNull(attribute?.type)?.toLowerCase();
      const whenFailed = stringOrNull(attribute?.when_failed)?.toLowerCase();
      if (!type?.includes("pre") || !type.includes("fail") || !whenFailed) continue;

      const name = ataAttributeName(attribute);
      if (whenFailed.includes("now")) {
        reportedPreFailNow = true;
        add("failing", `Pre-fail SMART attribute ${name} is below its threshold now.`);
      } else if (whenFailed.includes("past")) {
        reportedPreFailPast = true;
        add("warning", `Pre-fail SMART attribute ${name} failed in the past.`);
      }
    }
  }

  if ((exitStatus & 0b00010000) !== 0 && !reportedPreFailNow) {
    add("failing", "A pre-fail SMART attribute is below its threshold now.");
  }
  if ((exitStatus & 0b00100000) !== 0 && !reportedPreFailPast) {
    add("warning", "A pre-fail SMART attribute failed in the past.");
  }
  if ((exitStatus & 0b01000000) !== 0) {
    add("warning", "SMART error log contains recorded errors.");
  }
  if ((exitStatus & 0b10000000) !== 0) {
    add("warning", "SMART self-test log contains recorded errors.");
  }

  if (criticalWarning != null && criticalWarning !== 0) {
    if ((criticalWarning & 0b00001) !== 0) add("warning", "NVMe available spare capacity is below its threshold.");
    if ((criticalWarning & 0b00010) !== 0) add("warning", "NVMe temperature is outside its safe operating range.");
    if ((criticalWarning & 0b00100) !== 0) add("failing", "NVMe reliability is degraded.");
    if ((criticalWarning & 0b01000) !== 0) add("failing", "NVMe drive is in read-only mode.");
    if ((criticalWarning & 0b10000) !== 0) add("warning", "NVMe volatile-memory backup failed.");
    if ((criticalWarning & ~0b11111) !== 0) add("warning", "NVMe reports an unknown critical-warning condition.");
  }

  if (ssd) {
    if (ssd.percentageUsed != null && ssd.percentageUsed >= 100) {
      add("warning", `SSD rated endurance is exhausted (${ssd.percentageUsed}% used).`);
    }
    if (ssd.availableSparePercent != null
      && ssd.availableSpareThresholdPercent != null
      && ssd.availableSparePercent <= ssd.availableSpareThresholdPercent) {
      add("warning", `SSD available spare is ${ssd.availableSparePercent}% (threshold ${ssd.availableSpareThresholdPercent}%).`);
    }
    if (ssd.mediaErrors != null && ssd.mediaErrors > 0) {
      add("warning", `SSD reports ${ssd.mediaErrors.toLocaleString()} media/data-integrity error${ssd.mediaErrors === 1 ? "" : "s"}.`);
    }
    if (ssd.programFailures != null && ssd.programFailures > 0) {
      add("warning", `SSD reports ${ssd.programFailures.toLocaleString()} program failure${ssd.programFailures === 1 ? "" : "s"}.`);
    }
    if (ssd.eraseFailures != null && ssd.eraseFailures > 0) {
      add("warning", `SSD reports ${ssd.eraseFailures.toLocaleString()} erase failure${ssd.eraseFailures === 1 ? "" : "s"}.`);
    }
  }

  return conditions;
}

export function getSystemSmartAlertPayload(snapshot: SmartctlSnapshot): SystemSmartAlertPayload | null {
  const drives = snapshot.drives.flatMap((drive) => {
    if ((drive.status !== "warning" && drive.status !== "failing") || drive.alertConditions.length === 0) return [];
    const hasFailingCondition = drive.alertConditions.some((condition) => condition.severity === "failing");
    return [{
      device: drive.device,
      model: drive.model,
      status: drive.status === "failing" || hasFailingCondition ? "failing" as const : "warning" as const,
      conditions: drive.alertConditions,
    }];
  });
  return drives.length > 0 ? { checkedAt: snapshot.checkedAt, drives } : null;
}

/** Normalize smartctl's protocol-specific JSON without exposing full error logs or raw output. */
export function summarizeSmartctlReport(
  report: Record<string, any> | null,
  device: string,
  exitStatus: number,
  stderr = "",
): SmartDriveSummary {
  const nvme = report?.nvme_smart_health_information_log;
  const criticalWarning = numberOrNull(nvme?.critical_warning);
  const kind = driveKind(report, nvme ?? null);
  const ssd = kind === "ssd" ? createSsdMetrics(report ?? {}, nvme ?? null) : null;
  const hdd = kind === "hdd" ? createHddMetrics(report ?? {}) : null;
  const alertConditions = collectSmartAlertConditions(report, exitStatus, criticalWarning, ssd);
  const smartPassed = report?.smart_status?.passed;
  const inaccessible = !report || (exitStatus & 0b00000110) !== 0;
  const standby = exitStatus === 3 && !report?.smart_status && !nvme;
  const failing = smartPassed === false
    || (exitStatus & 0b00011000) !== 0
    || alertConditions.some((condition) => condition.severity === "failing");
  const ssdWarning = ssd != null && (
    (ssd.percentageUsed != null && ssd.percentageUsed >= 100)
    || (ssd.availableSparePercent != null
      && ssd.availableSpareThresholdPercent != null
      && ssd.availableSparePercent <= ssd.availableSpareThresholdPercent)
    || (ssd.mediaErrors != null && ssd.mediaErrors > 0)
    || (ssd.programFailures != null && ssd.programFailures > 0)
    || (ssd.eraseFailures != null && ssd.eraseFailures > 0)
  );
  const warning = (exitStatus & 0b11100000) !== 0
    || (criticalWarning != null && criticalWarning !== 0)
    || ssdWarning
    || alertConditions.length > 0;
  const status: SmartDriveStatus = standby
    ? "standby"
    : inaccessible
      ? "unavailable"
      : failing
        ? "failing"
        : warning
          ? "warning"
          : "ok";

  const temperature = numberOrNull(report?.temperature?.current)
    ?? numberOrNull(nvme?.temperature);
  const protocol = stringOrNull(report?.device?.protocol);
  const model = stringOrNull(report?.model_name)
    ?? stringOrNull(report?.model_family)
    ?? stringOrNull(report?.device?.name);
  const serialNumber = stringOrNull(report?.serial_number);
  const message = standby
    ? "Skipped to avoid waking a standby disk."
    : status === "unavailable"
      ? (stderr.trim() || "smartctl could not read SMART data from this device.")
      : null;

  return {
    device,
    protocol,
    kind,
    model,
    serialNumber,
    status,
    temperatureC: temperature,
    exitStatus,
    // Retained for existing consumers; use ssd.percentageUsed for new UI.
    percentageUsed: ssd?.percentageUsed ?? null,
    criticalWarning,
    ataAttributes: {
      // Attribute names are vendor-specific (some SSDs call ID 5
      // Reallocate_NAND_Blk_Cnt), but these ATA IDs are stable.
      reallocatedSectors: ataAttribute(report ?? {}, 5, ["Reallocated_Sector_Ct", "Reallocate_NAND_Blk_Cnt"]),
      pendingSectors: ataAttribute(report ?? {}, 197, ["Current_Pending_Sector"]),
      uncorrectableSectors: ataAttribute(report ?? {}, 198, ["Offline_Uncorrectable"]),
    },
    alertConditions,
    ssd,
    hdd,
    message,
  };
}

function parseJson(text: string): Record<string, any> | null {
  const parseObject = (candidate: string): Record<string, any> | null => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = parseObject(text);
  if (direct) return direct;

  // Some wrappers prepend a short diagnostic before passing smartctl's JSON
  // through. Preserve the strict path above, but recover the JSON object when
  // it is clearly embedded in otherwise non-JSON stdout.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return parseObject(text.slice(start, end + 1));
  return null;
}

function scanDeviceType(device: Record<string, any>): string | null {
  const type = stringOrNull(device.type);
  // smartctl device types contain only these characters. Keep a tight check in
  // case a broken external tool returns something unexpected.
  return type && /^[a-z0-9_+,:.-]+$/i.test(type) ? type : null;
}

interface SmartctlRead {
  result: SpawnAsyncResult;
  report: Record<string, any> | null;
}

async function readSmartctlJson(
  run: CommandRunner,
  command: string[],
): Promise<SmartctlRead> {
  const result = await run(command, { timeoutMs: SMARTCTL_TIMEOUT_MS });
  // smartctl uses a health bitmask for its exit code. A non-zero exit does
  // not by itself make the accompanying JSON report unusable.
  return { result, report: parseJson(result.stdout) };
}

function isStandbyResult(read: SmartctlRead): boolean {
  // --nocheck=standby,3 exits with the explicit status 3 before issuing the
  // SMART commands. Do not retry this case without --nocheck: waking sleeping
  // HDDs merely to populate an operator panel is not acceptable.
  return read.result.exitCode === 3 && !read.report;
}

function diagnosticText(result: SpawnAsyncResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (!detail) return "smartctl could not read SMART data from this device.";
  const compact = detail.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

/**
 * Some USB/SATA bridge scans return a device type that is too strict for the
 * subsequent read even though smartctl's normal auto-detection works. Try the
 * scanned type first, then safely fall back to auto-detection. If --nocheck
 * itself is unsupported, make one final read without it only after confirming
 * the drive was not skipped in standby mode.
 */
async function readDriveReport(
  binary: SmartctlBinary,
  device: string,
  type: string | null,
  run: CommandRunner,
): Promise<SmartctlRead> {
  const base = [binary.path, "--json=c", "--all", "--nocheck=standby,3"];
  const typedCommand = type ? [...base, "--device", type, device] : [...base, device];
  let read = await readSmartctlJson(run, typedCommand);
  if (read.report || isStandbyResult(read)) return read;

  // Device type from --scan-open is an optimization, not a requirement. Let
  // smartctl infer the transport itself before declaring the drive unreadable.
  if (type) {
    read = await readSmartctlJson(run, [...base, device]);
    if (read.report || isStandbyResult(read)) return read;
  }

  // Older installs may not support --nocheck's STATUS argument. This retry is
  // reached only after the no-wake command did not report a standby drive.
  return readSmartctlJson(run, [binary.path, "--json=c", "--all", device]);
}

async function collectSmartctlSnapshot(deps: SmartctlDependencies): Promise<SmartctlSnapshot> {
  const binary = await resolveSmartctlBinary(deps);
  const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
  if (!binary) {
    return { checkedAt, drives: [], error: "smartctl is not installed." };
  }

  const run = runner(deps);
  const scan = await run([binary.path, "--scan-open", "--json=c"], { timeoutMs: SMARTCTL_TIMEOUT_MS });
  const scanReport = parseJson(scan.stdout);
  const devices = Array.isArray(scanReport?.devices) ? scanReport.devices.slice(0, MAX_DISCOVERED_DRIVES) : [];
  if (!scanReport) {
    return {
      checkedAt,
      drives: [],
      error: scan.stderr.trim() || "smartctl could not scan for physical drives.",
    };
  }

  const drives: SmartDriveSummary[] = [];
  for (const found of devices) {
    const device = stringOrNull(found?.name);
    if (!device) continue;
    const type = scanDeviceType(found);
    const read = await readDriveReport(binary, device, type, run);
    const exitStatus = numberOrNull(read.report?.smartctl?.exit_status) ?? read.result.exitCode;
    drives.push(summarizeSmartctlReport(
      read.report,
      device,
      exitStatus,
      read.report ? read.result.stderr : diagnosticText(read.result),
    ));
  }

  return { checkedAt, drives, error: null };
}

export async function getSmartctlSnapshot(
  options: { force?: boolean } = {},
  deps: SmartctlDependencies = {},
): Promise<SmartctlSnapshot> {
  const now = (deps.now ?? Date.now)();
  if (!options.force && latestSnapshot) {
    const checkedAt = Date.parse(latestSnapshot.checkedAt);
    if (Number.isFinite(checkedAt) && now - checkedAt < SNAPSHOT_TTL_MS) return latestSnapshot;
  }
  if (snapshotPromise) return snapshotPromise;

  snapshotPromise = collectSmartctlSnapshot(deps)
    .then((snapshot) => {
      latestSnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      snapshotPromise = null;
    });
  return snapshotPromise;
}

export function resetSmartctlSnapshot(): void {
  latestSnapshot = null;
  snapshotPromise = null;
}

async function runScheduledSmartctlCheck(): Promise<void> {
  const status = await getSmartctlStatus();
  if (!status.binary) return;
  const snapshot = await getSmartctlSnapshot({ force: true });
  if (snapshot.error) {
    console.warn(`[smartctl] ${snapshot.error}`);
    return;
  }
  const unhealthy = snapshot.drives.filter((drive) => drive.status === "warning" || drive.status === "failing");
  if (unhealthy.length > 0) {
    console.warn(`[smartctl] ${unhealthy.length} drive(s) report SMART warnings: ${unhealthy.map((drive) => drive.device).join(", ")}`);
  }
  emitSmartctlAlert(snapshot);
}

function hasFailingSmartAlert(payload: SystemSmartAlertPayload): boolean {
  return payload.drives.some((drive) => (
    drive.status === "failing"
    || drive.conditions.some((condition) => condition.severity === "failing")
  ));
}

/** A stable warning identity that excludes the check timestamp. */
function getSmartWarningFingerprint(payload: SystemSmartAlertPayload): string {
  return payload.drives
    .map((drive) => [
      drive.device,
      drive.model ?? "",
      drive.status,
      ...drive.conditions
        .map((condition) => `${condition.severity}:${condition.message}`)
        .sort(),
    ].join("\u0001"))
    .sort()
    .join("\u0002");
}

/**
 * Emit a warning once per unchanged SMART condition. Failing conditions stay
 * persistent so operators who connect later continue to receive an error.
 */
function emitSmartctlAlert(snapshot: SmartctlSnapshot): void {
  const payload = getSystemSmartAlertPayload(snapshot);
  if (!payload) {
    lastSmartWarningFingerprint = null;
    return;
  }

  if (hasFailingSmartAlert(payload)) {
    // A later downgrade back to warning is a change worth surfacing.
    lastSmartWarningFingerprint = null;
  } else {
    const fingerprint = getSmartWarningFingerprint(payload);
    if (fingerprint === lastSmartWarningFingerprint) return;
    lastSmartWarningFingerprint = fingerprint;
  }

  for (const userId of getPrivilegedUserIds()) {
    eventBus.emit(EventType.SYSTEM_SMART_ALERT, payload, userId);
  }
}

function getPrivilegedUserIds(): string[] {
  try {
    const rows = getDb()
      .query(`SELECT id FROM "user" WHERE role IN ('owner', 'admin')`)
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  } catch (err) {
    console.warn("[smartctl] Failed to list privileged users for alert delivery:", err);
    return [];
  }
}

export function startSmartctlMonitor(): void {
  if (monitorTimer || process.env.LUMIVERSE_SMART_MONITOR === "false") return;
  void runScheduledSmartctlCheck().catch((err) => console.warn("[smartctl] Initial check failed:", err));
  monitorTimer = setInterval(() => {
    void runScheduledSmartctlCheck().catch((err) => console.warn("[smartctl] Scheduled check failed:", err));
  }, MONITOR_INTERVAL_MS);
  // SMART reads themselves are deliberately infrequent. Re-send only failing
  // alerts more often; warning alerts are emitted again only when evidence
  // changes.
  alertReemitTimer = setInterval(() => {
    if (latestSnapshot) emitSmartctlAlert(latestSnapshot);
  }, ALERT_REEMIT_INTERVAL_MS);
  if (typeof monitorTimer.unref === "function") monitorTimer.unref();
  if (typeof alertReemitTimer.unref === "function") alertReemitTimer.unref();
}

export function stopSmartctlMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  if (alertReemitTimer) clearInterval(alertReemitTimer);
  monitorTimer = null;
  alertReemitTimer = null;
}

/** Optional unattended provisioning for Docker/root deployments. */
export function initSmartctl(): void {
  if (process.env.LUMIVERSE_SMARTCTL_AUTO_INSTALL === "true") {
    void installSmartctl().then((result) => {
      if (result.installed) console.info("[smartctl] Installed smartmontools automatically.");
      else if (result.error && result.status.availability !== "available") console.info(`[smartctl] Automatic installation skipped: ${result.error}`);
    }).catch((err) => console.warn("[smartctl] Automatic installation failed:", err));
  }
  startSmartctlMonitor();
}
