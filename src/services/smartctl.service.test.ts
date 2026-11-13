import { describe, expect, test } from "bun:test";
import {
  getSmartctlCandidates,
  getSmartctlInstallPlan,
  getSmartctlSnapshot,
  getSystemSmartAlertPayload,
  summarizeSmartctlReport,
} from "./smartctl.service";

function result(exitCode = 0, stdout = "", stderr = "") {
  return Promise.resolve({ exitCode, stdout, stderr, timedOut: false });
}

describe("smartctl.service", () => {
  test("prioritizes an explicitly configured binary", () => {
    expect(getSmartctlCandidates({
      platform: "linux",
      env: { LUMIVERSE_SMARTCTL_PATH: "/opt/lumiverse/bin/smartctl" },
    })[0]).toBe("/opt/lumiverse/bin/smartctl");
  });

  test("selects the first available Linux package manager", async () => {
    const calls: string[][] = [];
    const plan = await getSmartctlInstallPlan({
      platform: "linux",
      isTermux: false,
      run: async (command) => {
        calls.push(command);
        return result(command[0] === "dnf" ? 0 : 1);
      },
    });

    expect(plan).toEqual({
      manager: "dnf",
      command: ["dnf", "install", "-y", "smartmontools"],
      requiresElevation: true,
    });
    expect(calls.map((command) => command[0])).toEqual(["apt-get", "dnf"]);
  });

  test("does not offer unsupported Termux installation", async () => {
    const plan = await getSmartctlInstallPlan({
      platform: "linux",
      isTermux: true,
      run: async () => result(),
    });
    expect(plan).toBeNull();
  });

  test("normalizes ATA warnings and NVMe health fields", () => {
    const drive = summarizeSmartctlReport({
      smartctl: { exit_status: 64 },
      device: { protocol: "ATA" },
      model_name: "Example SSD",
      serial_number: "serial",
      temperature: { current: 38 },
      ata_smart_attributes: {
        table: [
          { name: "Reallocated_Sector_Ct", raw: { value: 2 } },
          { name: "Current_Pending_Sector", raw: { value: 1 } },
        ],
      },
    }, "/dev/sda", 64);

    expect(drive).toMatchObject({
      status: "warning",
      model: "Example SSD",
      temperatureC: 38,
      ataAttributes: { reallocatedSectors: 2, pendingSectors: 1, uncorrectableSectors: null },
    });
  });

  test("extracts SATA SSD endurance, write volume, and NAND health counters", () => {
    const drive = summarizeSmartctlReport({
      smartctl: { exit_status: 0 },
      device: { protocol: "ATA" },
      model_name: "Example SATA SSD",
      logical_block_size: 512,
      ata_smart_attributes: {
        table: [
          { id: 5, name: "Reallocate_NAND_Blk_Cnt", raw: { value: 0 } },
          { id: 9, name: "Power_On_Hours", raw: { value: 25_892 } },
          { id: 12, name: "Power_Cycle_Count", raw: { value: 994 } },
          { id: 177, name: "Wear_Leveling_Count", raw: { value: 317 } },
          { id: 179, name: "Used_Rsvd_Blk_Cnt_Tot", raw: { value: 0 } },
          { id: 181, name: "Program_Fail_Cnt_Total", raw: { value: 0 } },
          { id: 182, name: "Erase_Fail_Cnt_Total", raw: { value: 0 } },
          { id: 187, name: "Reported_Uncorrect", raw: { value: 0 } },
          { id: 241, name: "Total_LBAs_Written", raw: { value: 65_497_295_214 } },
        ],
      },
    }, "/dev/sda", 0);

    expect(drive).toMatchObject({
      kind: "ssd",
      status: "ok",
      ataAttributes: { reallocatedSectors: 0 },
      ssd: {
        powerOnHours: 25_892,
        powerCycles: 994,
        wearLevelingCount: 317,
        reservedBlocksUsed: 0,
        programFailures: 0,
        eraseFailures: 0,
        mediaErrors: 0,
        dataWrittenBytes: 65_497_295_214 * 512,
      },
    });
  });

  test("extracts NVMe endurance, spare capacity, writes, and integrity errors", () => {
    const drive = summarizeSmartctlReport({
      smartctl: { exit_status: 0 },
      device: { protocol: "NVMe" },
      nvme_smart_health_information_log: {
        critical_warning: 0,
        percentage_used: 7,
        available_spare: 98,
        available_spare_threshold: 10,
        data_units_written: 1_384_224,
        power_on_hours: 129,
        power_cycles: 32,
        unsafe_shutdowns: 6,
        media_and_data_integrity_errors: 0,
      },
    }, "/dev/nvme0", 0);

    expect(drive).toMatchObject({
      kind: "ssd",
      status: "ok",
      percentageUsed: 7,
      ssd: {
        percentageUsed: 7,
        percentageRemaining: 93,
        availableSparePercent: 98,
        availableSpareThresholdPercent: 10,
        dataWrittenBytes: 1_384_224 * 512_000,
        powerOnHours: 129,
        powerCycles: 32,
        unsafeShutdowns: 6,
        mediaErrors: 0,
      },
    });
  });

  test("extracts HDD lifecycle metrics without treating a rotating disk as an SSD", () => {
    const drive = summarizeSmartctlReport({
      smartctl: { exit_status: 0 },
      device: { protocol: "ATA" },
      model_name: "Example HDD",
      rotation_rate: 7_200,
      power_on_time: { hours: 12_345 },
      power_cycle_count: 678,
      ata_smart_attributes: {
        table: [
          { id: 4, name: "Start_Stop_Count", raw: { value: 1_234 } },
          { id: 193, name: "Load_Cycle_Count", raw: { value: 56_789 } },
        ],
      },
    }, "/dev/sdb", 0);

    expect(drive).toMatchObject({
      kind: "hdd",
      status: "ok",
      ssd: null,
      hdd: {
        powerOnHours: 12_345,
        powerCycles: 678,
        startStopCount: 1_234,
        loadCycleCount: 56_789,
      },
    });
  });

  test("warns when SSD endurance or integrity counters cross a SMART limit", () => {
    const drive = summarizeSmartctlReport({
      smartctl: { exit_status: 0 },
      device: { protocol: "NVMe" },
      nvme_smart_health_information_log: {
        percentage_used: 100,
        available_spare: 9,
        available_spare_threshold: 10,
        media_and_data_integrity_errors: 1,
      },
    }, "/dev/nvme0", 0);

    expect(drive.status).toBe("warning");
  });

  test("preserves the exact ATA pre-fail condition for a user-facing alert", () => {
    const drive = summarizeSmartctlReport({
      smartctl: { exit_status: 32 },
      device: { protocol: "ATA" },
      ata_smart_attributes: {
        table: [{
          id: 195,
          name: "Cumulativ_Corrected_ECC",
          type: "Pre-fail",
          when_failed: "In_the_past",
          raw: { value: 0 },
        }],
      },
    }, "/dev/sda", 32);

    expect(drive).toMatchObject({
      status: "warning",
      alertConditions: [{
        severity: "warning",
        message: "Pre-fail SMART attribute Cumulativ Corrected ECC failed in the past.",
      }],
    });
  });

  test("creates a targeted alert payload only for warning or failing drives", () => {
    const failing = summarizeSmartctlReport({
      smartctl: { exit_status: 24 },
      device: { protocol: "ATA" },
      model_name: "At Risk Drive",
      ata_smart_attributes: {
        table: [{
          id: 5,
          name: "Reallocated_Sector_Ct",
          type: "Pre-fail",
          when_failed: "FAILING_NOW",
          raw: { value: 1 },
        }],
      },
    }, "/dev/sdb", 24);
    const healthy = summarizeSmartctlReport({
      smartctl: { exit_status: 0 },
      device: { protocol: "ATA" },
      smart_status: { passed: true },
    }, "/dev/sdc", 0);

    expect(getSystemSmartAlertPayload({
      checkedAt: "2026-07-11T12:00:00.000Z",
      error: null,
      drives: [healthy, failing],
    })).toEqual({
      checkedAt: "2026-07-11T12:00:00.000Z",
      drives: [{
        device: "/dev/sdb",
        model: "At Risk Drive",
        status: "failing",
        conditions: [{
          severity: "failing",
          message: "SMART overall-health check reports the drive is failing.",
        }, {
          severity: "failing",
          message: "Pre-fail SMART attribute Reallocated Sector Ct is below its threshold now.",
        }],
      }],
    });
  });

  test("does not wake standby drives and marks them separately", () => {
    const drive = summarizeSmartctlReport(null, "/dev/sdb", 3);
    expect(drive.status).toBe("standby");
    expect(drive.message).toContain("avoid waking");
  });

  test("discovers then reads each drive with compact JSON and no-wake mode", async () => {
    const calls: string[][] = [];
    const snapshot = await getSmartctlSnapshot({ force: true }, {
      platform: "linux",
      env: { LUMIVERSE_SMARTCTL_PATH: "/mock/smartctl" },
      now: () => Date.parse("2026-07-11T12:00:00.000Z"),
      run: async (command) => {
        calls.push(command);
        if (command.includes("--version")) return result(0, "smartctl 7.5");
        if (command.includes("--scan-open")) {
          return result(0, JSON.stringify({ devices: [{ name: "/dev/sda", type: "sat" }] }));
        }
        return result(0, JSON.stringify({
          smartctl: { exit_status: 0 },
          device: { protocol: "ATA" },
          model_name: "Test Disk",
          smart_status: { passed: true },
          temperature: { current: 31 },
        }));
      },
    });

    expect(snapshot).toMatchObject({
      checkedAt: "2026-07-11T12:00:00.000Z",
      error: null,
      drives: [{ device: "/dev/sda", status: "ok", temperatureC: 31 }],
    });
    expect(calls.at(-1)).toEqual([
      "/mock/smartctl",
      "--json=c",
      "--all",
      "--nocheck=standby,3",
      "--device",
      "sat",
      "/dev/sda",
    ]);
  });

  test("falls back to smartctl auto-detection when a scanned type cannot return JSON", async () => {
    const calls: string[][] = [];
    const snapshot = await getSmartctlSnapshot({ force: true }, {
      platform: "linux",
      env: { LUMIVERSE_SMARTCTL_PATH: "/mock/smartctl" },
      now: () => Date.parse("2026-07-11T13:00:00.000Z"),
      run: async (command) => {
        calls.push(command);
        if (command.includes("--version")) return result(0, "smartctl 7.5");
        if (command.includes("--scan-open")) {
          return result(0, JSON.stringify({ devices: [{ name: "/dev/sda", type: "sat" }] }));
        }
        if (command.includes("--device")) return result(2);
        return result(0, JSON.stringify({
          smartctl: { exit_status: 0 },
          device: { protocol: "ATA" },
          smart_status: { passed: true },
        }));
      },
    });

    expect(snapshot.drives[0]).toMatchObject({ device: "/dev/sda", status: "ok" });
    expect(calls.at(-1)).toEqual([
      "/mock/smartctl",
      "--json=c",
      "--all",
      "--nocheck=standby,3",
      "/dev/sda",
    ]);
  });

  test("accepts JSON preceded by a wrapper diagnostic", async () => {
    const snapshot = await getSmartctlSnapshot({ force: true }, {
      platform: "linux",
      env: { LUMIVERSE_SMARTCTL_PATH: "/mock/smartctl" },
      now: () => Date.parse("2026-07-11T14:00:00.000Z"),
      run: async (command) => {
        if (command.includes("--version")) return result(0, "smartctl 7.5");
        if (command.includes("--scan-open")) {
          return result(0, "wrapper notice\n" + JSON.stringify({ devices: [{ name: "/dev/sda" }] }));
        }
        return result(0, "wrapper notice\n" + JSON.stringify({
          smartctl: { exit_status: 0 },
          device: { protocol: "ATA" },
          smart_status: { passed: true },
        }));
      },
    });

    expect(snapshot).toMatchObject({ error: null, drives: [{ device: "/dev/sda", status: "ok" }] });
  });
});
