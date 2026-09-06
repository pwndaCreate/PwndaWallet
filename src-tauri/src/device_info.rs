//! Hardware detection — CPU + GPU model strings, threads, VRAM.
//!
//! Two backends, selected by `#[cfg]`:
//! - **Windows**: PowerShell `Get-CimInstance Win32_Processor` for CPU + a
//!   registry walk of the display-adapter class for GPU (more accurate VRAM
//!   than `Win32_VideoController.AdapterRAM`'s 32-bit cap).
//! - **Linux**: parse `/proc/cpuinfo` + `/sys/devices/system/cpu` for CPU;
//!   walk `/sys/class/drm/card*/device/` for GPU vendor/device IDs, then
//!   resolve human-readable names via `lspci -nn` if available.
//!
//! Both backends return the same `CpuInfo` / `GpuInfo` shape so the
//! frontend doesn't branch.

use serde::Serialize;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// CPU snapshot — what `Get-CimInstance Win32_Processor` returns plus
/// the host's thread count (for sanity-checking against the WMI value
/// when a system has multiple sockets).
#[derive(Debug, Serialize, Default)]
pub struct CpuInfo {
    /// "13th Gen Intel(R) Core(TM) i9-13900K" etc., as reported by WMI.
    pub name: String,
    /// Logical processors (== `num_cpus::get()` on a single-socket box).
    pub threads: u32,
    /// Physical cores (RandomX scales near-linearly on these, sub-
    /// linearly on SMT siblings — the predicted-hashrate formula
    /// weights physical cores 1.0× and threads 0.6×).
    pub physical_cores: u32,
    /// Reported max clock in MHz from WMI's `MaxClockSpeed`.
    pub max_mhz: u32,
}

/// One discrete GPU detected via `Get-CimInstance Win32_VideoController`.
/// We filter out Microsoft Basic Render Driver, IDD / VR / remote-desktop
/// virtual displays, and Intel integrated graphics before returning to
/// the JS layer — see the `drop_patterns` list inside `get_gpu_info`
/// for the full list and the rationale for keeping Intel Arc visible.
#[derive(Debug, Serialize, Default)]
pub struct GpuInfo {
    /// "NVIDIA GeForce RTX 5060 Ti" etc.
    pub name: String,
    /// Coarse vendor classification — used to pick the right GPU
    /// miner (NVIDIA → SRBMiner / lolMiner, AMD → SRBMiner, Intel →
    /// neither today).
    pub vendor: String,
    /// VRAM in bytes. May be 0 when WMI's `AdapterRAM` is unavailable
    /// (Win32 caps it at 4 GB on some drivers); we surface as a
    /// rough indicator only.
    pub vram_bytes: u64,
    /// Driver version string, useful for debugging benchmark
    /// regressions tied to a driver update.
    pub driver_version: String,
}

/// PowerShell 5.1's `ConvertTo-Json` returns `{...}` for a single
/// result and `[{...}, ...]` for multiple. PS 6+ has `-AsArray` to
/// force list shape but PS 5.1 (the Windows default) doesn't. This
/// helper accepts either shape and yields a `Vec<T>` so the callers
/// don't have to branch on PS version.
#[cfg(target_os = "windows")]
fn into_rows<T: serde::de::DeserializeOwned>(raw: &str) -> Result<Vec<T>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    // Parse to a generic Value first so we can branch on the JSON
    // shape — array → as-is, object → wrap in single-element vec.
    let v: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("{}", e))?;
    match v {
        serde_json::Value::Array(arr) => arr
            .into_iter()
            .map(|item| serde_json::from_value::<T>(item).map_err(|e| format!("{}", e)))
            .collect(),
        serde_json::Value::Object(_) => {
            let one: T = serde_json::from_value(v).map_err(|e| format!("{}", e))?;
            Ok(vec![one])
        }
        _ => Err("Expected JSON object or array".to_string()),
    }
}

/// Helper — spawn PowerShell with the standard hidden-window flags
/// `miners.rs` uses elsewhere. Same surface area, kept private to
/// this module so the import graph stays clean.
#[cfg(target_os = "windows")]
fn hidden_powershell() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass"]);
    cmd
}

/// Get the host CPU info. Single-shot — callers should cache.
#[tauri::command]
pub async fn get_cpu_info() -> Result<CpuInfo, String> {
    #[cfg(target_os = "linux")]
    {
        return linux::cpu_info().await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        return Err("CPU detection not implemented on this platform".into());
    }

    #[cfg(target_os = "windows")]
    {
        // We deliberately don't pass `-AsArray` — that flag was added
        // in PowerShell 6.0+, and PS 5.1 (the Windows default) errors
        // out on it. On PS 5.1 a single-row result serializes as
        // `{...}` and multi-row as `[{...}, ...]`; we normalize that
        // shape on the Rust side via `into_rows` below.
        let script = r#"
            Get-CimInstance -ClassName Win32_Processor |
                Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed |
                ConvertTo-Json -Compress
        "#;

        let out = hidden_powershell()
            .args(["-Command", script])
            .output()
            .await
            .map_err(|e| format!("Spawn powershell: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "Get-CimInstance failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);

        #[derive(serde::Deserialize)]
        #[allow(non_snake_case)]
        struct Row {
            Name: Option<String>,
            NumberOfCores: Option<u32>,
            NumberOfLogicalProcessors: Option<u32>,
            MaxClockSpeed: Option<u32>,
        }

        let rows: Vec<Row> = into_rows(stdout.trim())
            .map_err(|e| format!("Parse CPU JSON: {} — raw: {}", e, stdout))?;

        // Sum across sockets. Most users have one CPU but be defensive.
        let mut info = CpuInfo::default();
        for r in &rows {
            if info.name.is_empty() {
                info.name = r.Name.clone().unwrap_or_default().trim().into();
            }
            info.physical_cores += r.NumberOfCores.unwrap_or(0);
            info.threads += r.NumberOfLogicalProcessors.unwrap_or(0);
            info.max_mhz = info.max_mhz.max(r.MaxClockSpeed.unwrap_or(0));
        }
        Ok(info)
    }
}

/// Enumerate every video controller WMI knows about. The integrated
/// "Microsoft Basic Render Driver" + IDD-style virtual displays show up
/// here too; we filter them out before returning.
#[tauri::command]
pub async fn get_gpu_info() -> Result<Vec<GpuInfo>, String> {
    #[cfg(target_os = "linux")]
    {
        return linux::gpu_info().await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        return Err("GPU detection not implemented on this platform".into());
    }

    #[cfg(target_os = "windows")]
    {
        // VRAM source: `Win32_VideoController.AdapterRAM` is a documented
        // `uint32` (max 4 GB - 1 byte) — every modern GPU exceeds that
        // cap, so the WMI value pins at ~4 GB and is useless. The
        // registry's `HardwareInformation.qwMemorySize` under each
        // display-adapter class subkey is a 64-bit QWORD with the real
        // VRAM. We read both: registry for VRAM (accurate), other
        // fields from the same registry path (DriverDesc, DriverVersion,
        // ProviderName) — no need for a separate WMI call.
        // Class GUID `{4d36e968-e325-11ce-bfc1-08002be10318}` is the
        // Display Adapters class.
        let script = r#"
            $cls = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
            $rows = @()
            Get-ChildItem -Path $cls -ErrorAction SilentlyContinue | ForEach-Object {
                $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
                if ($null -eq $p) { return }
                $name = $p.DriverDesc
                if ([string]::IsNullOrEmpty($name)) { return }
                # Dotted property name needs bracket access. QWORD reads
                # as Int64 in PS 5.1.
                $vram = $p.'HardwareInformation.qwMemorySize'
                $rows += [PSCustomObject]@{
                    Name = $name
                    AdapterCompatibility = $p.ProviderName
                    AdapterRAM = if ($null -eq $vram) { 0 } else { [int64]$vram }
                    DriverVersion = $p.DriverVersion
                }
            }
            $rows | ConvertTo-Json -Compress
        "#;

        let out = hidden_powershell()
            .args(["-Command", script])
            .output()
            .await
            .map_err(|e| format!("Spawn powershell: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "Get-CimInstance video failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);

        #[derive(serde::Deserialize)]
        #[allow(non_snake_case)]
        struct Row {
            Name: Option<String>,
            AdapterCompatibility: Option<String>,
            AdapterRAM: Option<i64>, // signed because WMI sometimes returns negative for >2GB
            DriverVersion: Option<String>,
        }

        let rows: Vec<Row> = into_rows(stdout.trim())
            .map_err(|e| format!("Parse GPU JSON: {} — raw: {}", e, stdout))?;

        // Drop virtual / placeholder adapters AND integrated Intel GPUs.
        //
        // The WMI surface includes the basic display driver every time,
        // plus any IDD virtual displays from streaming software (Parsec,
        // OBS, etc.) and from VR headsets that render the desktop into
        // the headset (Meta Quest Link / Air Link's "Meta Virtual
        // Monitor"). None of these are minable.
        //
        // Intel integrated GPUs (UHD / HD / Iris) are real silicon but
        // unsupported by every GPU miner PwndaWallet ships — SRBMiner /
        // lolMiner are NVIDIA + AMD only — so showing them in
        // the device list is noise the user can't act on. Discrete
        // Intel Arc cards (`Intel(R) Arc(TM) A380 Graphics`,
        // `… A770 Graphics`, etc.) are NOT filtered: the pattern list
        // matches "UHD Graphics" / "HD Graphics" / "Iris" specifically,
        // never the bare word "Graphics", so Arc stays visible. Even
        // though Arc has no working miner today, surfacing it lets the
        // user know we saw it (and benchmark-prediction support can
        // land later without re-thinking detection).
        let drop_patterns = [
            // Stub / virtual-display drivers
            "Microsoft Basic Render",
            "Microsoft Basic Display",
            "Remote Display",
            "Virtual Display",
            "DisplayLink",
            "IDD",
            "Parsec Virtual",
            // VR headset / remote-desktop virtual monitors
            "Meta Virtual",         // Meta Quest Link / Air Link
            "Oculus Virtual",       // pre-rebrand alias
            "Spacedesk",            // tablet-as-second-screen
            "iVCam",                // phone-as-camera
            // Intel integrated graphics (no GPU miner supports them)
            "UHD Graphics",
            "HD Graphics",
            "Iris",
        ];

        let mut out_vec: Vec<GpuInfo> = Vec::new();
        for r in rows {
            let name = r.Name.clone().unwrap_or_default().trim().to_string();
            if name.is_empty() {
                continue;
            }
            if drop_patterns.iter().any(|p| name.contains(p)) {
                continue;
            }
            let vendor = classify_vendor(&name, r.AdapterCompatibility.as_deref());
            let vram_bytes = match r.AdapterRAM {
                Some(n) if n > 0 => n as u64,
                _ => 0,
            };
            out_vec.push(GpuInfo {
                name,
                vendor,
                vram_bytes,
                driver_version: r.DriverVersion.unwrap_or_default(),
            });
        }
        Ok(out_vec)
    }
}

/// Linux device-info backend. Pure sysfs + lspci, no external crates.
///
/// CPU: `/proc/cpuinfo` (model name, siblings) + `/sys/devices/system/cpu/`
/// for physical-core dedup and max frequency.
///
/// GPU: enumerate `/sys/class/drm/card*/device/`, read `vendor` + `device`
/// PCI IDs + `mem_info_vram_total` (AMD only) for VRAM. Names come from
/// `lspci -mm -nn -d ::0300` (display controllers, class 0x0300). NVIDIA's
/// `nvidia-smi` would give better names but adds an external runtime dep we
/// don't want to require — lspci ships with every distro.
#[cfg(target_os = "linux")]
mod linux {
    use super::{classify_vendor_pci, CpuInfo, GpuInfo};
    use std::collections::HashSet;
    use std::path::Path;
    use tokio::process::Command;

    pub async fn cpu_info() -> Result<CpuInfo, String> {
        let raw = tokio::fs::read_to_string("/proc/cpuinfo")
            .await
            .map_err(|e| format!("/proc/cpuinfo: {}", e))?;

        let mut name = String::new();
        let mut threads: u32 = 0;
        let mut core_ids: HashSet<(String, String)> = HashSet::new();

        for block in raw.split("\n\n") {
            let mut block_has_processor = false;
            let mut current_physical_id: Option<String> = None;
            let mut current_core_id: Option<String> = None;
            for line in block.lines() {
                let (k, v) = match line.split_once(':') {
                    Some((k, v)) => (k.trim(), v.trim()),
                    None => continue,
                };
                match k {
                    "processor" => {
                        block_has_processor = true;
                        threads += 1;
                    }
                    "model name" if name.is_empty() => name = v.to_string(),
                    "physical id" => current_physical_id = Some(v.to_string()),
                    "core id" => current_core_id = Some(v.to_string()),
                    _ => {}
                }
            }
            if block_has_processor {
                if let (Some(p), Some(c)) = (current_physical_id, current_core_id) {
                    core_ids.insert((p, c));
                }
            }
        }

        // physical_cores = unique (physical id, core id) tuples. Some kernels
        // omit those fields (e.g. inside containers without /proc/cpuinfo
        // virtualization) — in that case fall back to thread count.
        let physical_cores = if core_ids.is_empty() {
            threads
        } else {
            core_ids.len() as u32
        };

        let max_mhz = read_max_mhz();

        Ok(CpuInfo {
            name: name.trim().to_string(),
            threads,
            physical_cores,
            max_mhz,
        })
    }

    fn read_max_mhz() -> u32 {
        // cpufreq exposes per-CPU max frequency in kHz. Some kernels (or
        // VMs without cpufreq) omit it — return 0 in that case and let the
        // UI render "—".
        if let Ok(s) = std::fs::read_to_string(
            "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq",
        ) {
            if let Ok(khz) = s.trim().parse::<u64>() {
                return (khz / 1000) as u32;
            }
        }
        0
    }

    pub async fn gpu_info() -> Result<Vec<GpuInfo>, String> {
        // Map PCI BDF (e.g. "0000:01:00.0") → metadata from sysfs.
        let mut sysfs_devices: Vec<SysfsGpu> = Vec::new();
        let drm = Path::new("/sys/class/drm");
        if let Ok(entries) = std::fs::read_dir(drm) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let n = name.to_string_lossy();
                // We want primary card nodes like `card0`, not `card0-eDP-1`.
                if !n.starts_with("card") || n.contains('-') {
                    continue;
                }
                let dev_path = entry.path().join("device");
                if let Some(parsed) = read_sysfs_gpu(&dev_path) {
                    sysfs_devices.push(parsed);
                }
            }
        }

        if sysfs_devices.is_empty() {
            // Pure-VM environment (no DRM nodes) — fall back to lspci alone.
            return parse_lspci(None).await;
        }

        // Resolve human-readable names by parsing `lspci -mm -nn -D`.
        // Map BDF → name string. lspci output looks like:
        //   0000:01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GA106 …"
        let lspci_names = parse_lspci_names().await.unwrap_or_default();

        let mut out: Vec<GpuInfo> = Vec::new();
        for d in sysfs_devices {
            // Filter virtual / placeholder PCI IDs (QEMU's 0x1234 cirrus,
            // VMware 0x15ad svga, RedHat 0x1b36 qxl, etc.).
            const VIRTUAL_VENDORS: &[u16] = &[0x1234, 0x15ad, 0x1b36, 0x1af4];
            if VIRTUAL_VENDORS.contains(&d.vendor) {
                continue;
            }

            let name = lspci_names
                .iter()
                .find(|(bdf, _)| bdf == &d.bdf)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| format!("PCI {:04x}:{:04x}", d.vendor, d.device));

            let vendor = classify_vendor_pci(d.vendor);

            // Skip Intel integrated graphics the same way the Windows path
            // does. Intel Arc discrete cards have class 0x0380 (3D
            // controller) or 0x0300 — kept either way; integrated UHD/HD
            // matches by name substring.
            if vendor == "intel" {
                let lower = name.to_ascii_lowercase();
                if lower.contains("uhd graphics")
                    || lower.contains("hd graphics")
                    || lower.contains("iris")
                {
                    continue;
                }
            }

            out.push(GpuInfo {
                name,
                vendor,
                vram_bytes: d.vram_bytes,
                driver_version: String::new(),
            });
        }
        Ok(out)
    }

    struct SysfsGpu {
        bdf: String,
        vendor: u16,
        device: u16,
        vram_bytes: u64,
    }

    fn read_sysfs_gpu(dev_path: &Path) -> Option<SysfsGpu> {
        // sysfs `device` symlink points to e.g. /sys/devices/pci0000:00/0000:00:01.0/0000:01:00.0
        let real = std::fs::canonicalize(dev_path).ok()?;
        let bdf = real.file_name()?.to_string_lossy().to_string();

        let vendor = read_hex_u16(&dev_path.join("vendor"))?;
        let device = read_hex_u16(&dev_path.join("device"))?;

        // AMD exposes mem_info_vram_total (bytes). NVIDIA + Intel don't —
        // VRAM reporting requires nvidia-smi or lspci -v. We accept VRAM=0
        // on those; the UI shows "—" for unknown.
        let vram_bytes = std::fs::read_to_string(dev_path.join("mem_info_vram_total"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);

        Some(SysfsGpu {
            bdf,
            vendor,
            device,
            vram_bytes,
        })
    }

    fn read_hex_u16(p: &Path) -> Option<u16> {
        let raw = std::fs::read_to_string(p).ok()?;
        let s = raw.trim().trim_start_matches("0x");
        u16::from_str_radix(s, 16).ok()
    }

    /// Parse `lspci -mm -nn -D` output into a Vec<(BDF, friendly_name)>.
    /// Returns `Ok(empty)` if lspci is missing or fails — callers fall back
    /// to PCI-ID strings.
    async fn parse_lspci_names() -> Result<Vec<(String, String)>, String> {
        let out = Command::new("lspci")
            .args(["-mm", "-nn", "-D"])
            .output()
            .await
            .map_err(|e| format!("lspci: {}", e))?;
        if !out.status.success() {
            return Ok(Vec::new());
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut result = Vec::new();
        for line in text.lines() {
            // lspci -mm format: "BDF "Class [code]" "Vendor [vid]" "Device [did]" …"
            // Class 0300 = VGA, 0302 = 3D controller (Arc/headless cards).
            if !line.contains("[0300]") && !line.contains("[0302]") && !line.contains("[0380]") {
                continue;
            }
            let bdf = line.split_whitespace().next().unwrap_or("").to_string();
            // Build a friendly name: vendor + device (strip the [xxxx] tags).
            let parts: Vec<String> = line
                .split('"')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .collect();
            // parts: [BDF? trimmed, class str, vendor str, device str, …]
            // After splitting on `"`, the order is: leading-whitespace, class,
            // separator, vendor, separator, device, …
            let (vendor_name, device_name) = match parts.as_slice() {
                [_bdf, _class, vendor, device, ..] => (
                    strip_pci_tag(vendor),
                    strip_pci_tag(device),
                ),
                _ => continue,
            };
            let friendly = format!("{} {}", vendor_name, device_name).trim().to_string();
            result.push((bdf, friendly));
        }
        Ok(result)
    }

    /// Fallback for when sysfs/drm has no entries (rare — VMs without
    /// graphics passthrough). Uses lspci alone to enumerate.
    async fn parse_lspci(_filter: Option<&str>) -> Result<Vec<GpuInfo>, String> {
        let pairs = parse_lspci_names().await?;
        let mut out = Vec::new();
        for (_bdf, name) in pairs {
            let lower = name.to_ascii_lowercase();
            let vendor = if lower.contains("nvidia") {
                "nvidia"
            } else if lower.contains("amd") || lower.contains("ati") {
                "amd"
            } else if lower.contains("intel") {
                "intel"
            } else {
                "other"
            };
            if vendor == "intel"
                && (lower.contains("uhd graphics")
                    || lower.contains("hd graphics")
                    || lower.contains("iris"))
            {
                continue;
            }
            out.push(GpuInfo {
                name,
                vendor: vendor.into(),
                vram_bytes: 0,
                driver_version: String::new(),
            });
        }
        Ok(out)
    }

    fn strip_pci_tag(s: &str) -> String {
        // "NVIDIA Corporation [10de]" → "NVIDIA Corporation"
        if let Some(idx) = s.rfind(" [") {
            return s[..idx].trim().to_string();
        }
        s.trim().to_string()
    }
}

/// Classify a PCI vendor ID into the same vendor strings the Windows path
/// uses. Kept as a free function so both platform backends share it.
#[cfg(target_os = "linux")]
fn classify_vendor_pci(vendor_id: u16) -> String {
    match vendor_id {
        0x10de => "nvidia".into(),
        0x1002 | 0x1022 => "amd".into(), // 0x1022 is the integrated APU PCH path
        0x8086 => "intel".into(),
        _ => "other".into(),
    }
}

/// Classify a GPU as nvidia / amd / intel / other. The model name is
/// the most reliable signal; `AdapterCompatibility` is a fallback
/// because vendors flag their own driver string differently.
#[cfg(target_os = "windows")]
fn classify_vendor(name: &str, compatibility: Option<&str>) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("nvidia") || lower.contains("geforce") || lower.contains("rtx") || lower.contains("gtx") {
        return "nvidia".into();
    }
    if lower.contains("amd") || lower.contains("radeon") || lower.contains("rx ") {
        return "amd".into();
    }
    if lower.contains("intel") || lower.contains("arc") {
        return "intel".into();
    }
    if let Some(c) = compatibility {
        let cl = c.to_ascii_lowercase();
        if cl.contains("nvidia") {
            return "nvidia".into();
        }
        if cl.contains("amd") || cl.contains("ati") {
            return "amd".into();
        }
        if cl.contains("intel") {
            return "intel".into();
        }
    }
    "other".into()
}
