---
title: Disk Health & SMART
---

# Disk Health & SMART

Lumiverse can read [SMART](https://www.smartmontools.org/wiki/WhatIsSmart) health information from physical HDDs, SATA SSDs, and NVMe SSDs. Open **Settings → Operator → Disk Health** to see the latest result.

SMART is a useful early-warning system, not a guarantee that a drive will or will not fail. Keep tested backups regardless of the reported state.

---

## Install smartmontools

From the Lumiverse project directory, run:

```bash
bun run install:smartctl
```

The command detects the supported package manager on your system and installs the `smartmontools` package, which provides `smartctl`. On Linux it opens the normal `sudo` prompt only for the package-manager command; Lumiverse never receives or stores your administrator password.

After it succeeds, restart Lumiverse and use **Refresh SMART Data** in **Settings → Operator → Disk Health**.

!!! note "Automatic first-run setup"
    The first-run wizard offers this installation automatically. Run `bun run install:smartctl` later if you skipped it or if the installation did not complete.

### If the installer cannot install it

Install `smartmontools` with your operating system's package manager, then restart Lumiverse.

| Platform | Command |
|----------|---------|
| Debian / Ubuntu | `sudo apt-get install smartmontools` |
| Fedora / RHEL | `sudo dnf install smartmontools` |
| Arch Linux | `sudo pacman -S smartmontools` |
| Alpine | `sudo apk add smartmontools` |
| openSUSE | `sudo zypper install smartmontools` |
| macOS (Homebrew) | `brew install smartmontools` |

On Windows, install smartmontools with its installer or `choco install smartmontools -y`, then restart Lumiverse as an Administrator. Native Termux normally cannot access physical disks, so Disk Health is unavailable there by default.

---

## Linux: running Lumiverse with SMART access

On Linux, reading a physical drive's SMART log normally requires root-level access to the block device. Installing `smartmontools` is not enough by itself: the **Lumiverse backend process must currently run with `sudo`/root privileges** to collect SMART data.

1. Stop the normal Lumiverse process.
2. Install smartmontools with `bun run install:smartctl`.
3. From the project directory, start Lumiverse with:

    ```bash
    sudo -E ./start.sh
    ```

4. Open **Settings → Operator → Disk Health** and select **Refresh SMART Data**.

`-E` preserves the current shell environment so the elevated launcher can find a Bun installation that belongs to your user account. If your system does not permit `sudo -E`, start it with explicit environment values instead:

```bash
sudo env "PATH=$PATH" "BUN_INSTALL=${BUN_INSTALL:-$HOME/.bun}" ./start.sh
```

!!! warning "Running the whole server as root"
    This grants root access to Lumiverse, its installed extensions, and every process it starts. Use it only on a trusted, locally administered machine. Keep remote access disabled unless it is protected by strong authentication and a trusted network. Do not make block devices world-readable or add the service user to a broad disk-access group just to enable SMART; those changes can also permit raw disk writes.

!!! warning "File ownership"
    A root-run server can create root-owned files in `data/`, logs, and caches. If you later return to running Lumiverse as your normal user, fix the ownership first:

    ```bash
    sudo chown -R "$USER":"$(id -gn)" data
    ```

### Services and Docker

For a system service, configure the Lumiverse process to run as `root` and use absolute paths for the working directory and Bun executable. Do not rely on an interactive `sudo` prompt in a service definition.

Docker needs a different form of access: map only the specific host devices to monitor and grant the required raw-I/O capability. See the commented SMART example in `docker-compose.yml`. Do not use Docker's `privileged: true` mode solely for Disk Health.

---

## Understanding the health status

| Status | Meaning | What to do |
|--------|---------|------------|
| **Healthy** | No SMART failure or warning evidence was reported. | Continue normal backups and periodic checks. |
| **Warning** | SMART has a historical pre-fail condition, logged errors, or a concerning SSD metric. | Back up important data promptly and inspect the condition text. Watch whether the count changes. |
| **Failing** | SMART says the drive is failing, a pre-fail value is below its threshold now, or NVMe reports a severe condition such as read-only mode. | Back up immediately and plan to replace the drive. |
| **Unavailable** | Lumiverse could not read SMART data. This is not a health result. | Check installation, Linux privilege, USB/SATA bridge support, or Docker device access. |
| **Standby** | Lumiverse deliberately skipped a sleeping drive. | Refresh after the drive is active if you need a result; Lumiverse will not wake it just for monitoring. |

When SMART finds a warning or failure, owners and admins receive a Disk Health toast once per browser page load. It names the affected drive and the evidence behind the alert. The current alert is re-delivered periodically for operators who connect after startup.

---

## SSD metrics

Lumiverse shows only values that the SSD controller actually reports. ATA/SATA attribute names are vendor-specific, so some fields may be absent.

| Metric | Meaning |
|--------|---------|
| **Wear used / Endurance remaining** | The controller's estimate of rated write endurance used and left. NVMe may report more than 100% used after its rated endurance is exhausted. |
| **Available spare** | Remaining replacement flash blocks on NVMe. A value at or below the drive's threshold is a warning. |
| **Data written** | Host writes reported by the controller. This is useful for comparing with the drive's endurance rating, but it is not a direct failure prediction. |
| **Media errors** | NVMe media/data-integrity errors, or the closest ATA equivalent when available. Non-zero values deserve investigation. |
| **Program / erase failures** | NAND programming or erase failures reported by some SATA SSDs. Non-zero values are warnings. |
| **Wear-leveling / reserved blocks** | Vendor-specific counters for flash wear and spare-block consumption. Compare their trend over time rather than assuming a universal threshold. |
| **Unsafe shutdowns** | NVMe power losses without a clean shutdown. This is useful context, but does not by itself mean the SSD is failing. |

---

## HDD metrics

In addition to temperature and error counters, rotating drives show these lifecycle values when supported:

| Metric | Meaning |
|--------|---------|
| **Power-on hours** | Total time the drive has been powered. Useful context for age and warranty, not a failure verdict by itself. |
| **Power cycles** | Number of times the drive has been powered on. |
| **Start/stop cycles** | Number of spindle start/stop operations. |
| **Load/unload cycles** | Number of head-load or head-park cycles. Frequent parking can make this rise quickly on some laptop drives. |
| **Reallocated sectors** | Sectors remapped to spare space. A rising count is a reason to back up and investigate. |
| **Pending sectors** | Sectors waiting to be re-tested or remapped. Back up promptly; these are often more urgent than a stable historical reallocation count. |
| **Uncorrectable sectors** | Sectors the drive could not read during an offline scan. Treat a non-zero or rising value seriously. |

## Pre-fail conditions

**Pre-fail** is an ATA SMART attribute category, not an immediate failure message. A pre-fail attribute matters when its **WHEN_FAILED** state reports one of the following:

- **FAILING_NOW** — the attribute's normalized value is currently at or below its manufacturer threshold. Lumiverse marks the drive as **Failing**.
- **In_the_past** — the attribute crossed its threshold previously. Lumiverse marks it as a **Warning** and includes the attribute name in the toast and Disk Health details.

For example, `Cumulativ_Corrected_ECC` with `In_the_past` means the drive recorded that pre-fail condition in its history. It does not prove the drive is failing right now, but it is a good reason to verify backups, inspect the full `smartctl --all /dev/sdX` report, and monitor for new or increasing errors.

---

## Troubleshooting

### `smartctl could not read SMART data from this device`

On Linux, first confirm that Lumiverse itself was started with `sudo` as described above. Then test the drive directly in a local terminal:

```bash
sudo smartctl --all /dev/sda
```

Replace `/dev/sda` with the device shown in Disk Health. If the command works directly but not in Lumiverse, restart the elevated Lumiverse process and refresh the page. USB-to-SATA bridges sometimes need a transport-specific smartctl device type; Lumiverse attempts auto-detection, but not every bridge exposes SMART data.

### No drives found in Docker

The container cannot see host drives by default. Map the exact devices you want to monitor and add the raw-I/O capability shown in the compose-file example. Do not expose every device or use privileged mode solely for SMART.
