//! XelisHash GPU thread count, estimated from what the card IS rather than
//! from how much memory it has (2026-09-17).
//!
//! SRBMiner's own tune sizes XelisHash by VRAM: it keeps adding threads, each
//! with its own 531 KiB scratchpad, until the card is nearly full (15360
//! threads on a 12 GB RX 6700 XT, saved in `miners/Autotune/`). Measured on the
//! dev box, a 2 GB budget (3840 threads per card) mined as fast as that on
//! both an RX 6700 XT and an RTX 5060 Ti: past a point, extra threads only
//! queue for the same memory bus. That point follows the card's core count,
//! which `SRBMiner-MULTI --list-devices` prints with no pool and no mining
//! (0.65 s), on Windows and Linux alike:
//!
//! ```text
//! GPU0  [0][0] [06:00.0] : amd_radeon_rx_6700_xt [gfx1031] [12272 MB] [CU: 40] [MaxBuf: 12272 MB]
//! GPU1  [CUDA][0] [0000:01:00.0] : nvidia_geforce_rtx_5060_ti [blackwell] [CC: 12.0] [SM: 36] [16310 MB]
//! ```
//!
//! So the estimate is `cores x threads-per-core` for the card's architecture,
//! rounded down to 256 and never above 90% of the card's memory. Rows are
//! marked `Measured` only where a real card backs them; every other row is
//! `Assumed` at the same value until someone measures it. A card this table
//! cannot place (no core count, unknown vendor) gets no estimate, and
//! SRBMiner's own tune runs as before.
//!
//! The detected profile is saved as plaintext JSON in the app-data folder
//! (machine facts, not secrets; the mining module never touches the vault —
//! BOUNDARIES.md). It is re-detected on every XelisHash GPU start, so a swapped
//! card is picked up; the saved copy is the fallback when detection fails.

use super::{gpu_threads_for_vram_limit, MinerGpuDevice, XELISHASH_V3_SCRATCHPAD_BYTES};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Whether a table row rests on a real card or is carried over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Basis {
    /// A card of this family was measured on the dev box.
    Measured,
    /// No measurement yet; the measured families' value is reused.
    Assumed,
}

/// Threads per compute unit (AMD CU / NVIDIA SM). 2026-09-17 dev box: 3840
/// threads per card matched SRBMiner's VRAM-filling tune on both cards. At
/// 112, the RTX 5060 Ti (36 SM) lands on exactly that 3840 and the RX 6700 XT
/// (40 CU) on 4352, so neither card is sent fewer threads than were measured
/// sufficient.
pub const THREADS_PER_CORE: u32 = 112;

/// Thread counts are multiples of this, as SRBMiner's own tune picks them;
/// it also keeps every value above 31, so SRBMiner reads it as RAW intensity.
const STEP: u32 = 256;

/// The architecture family a card belongs to, for the table and the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Family {
    pub name: &'static str,
    pub threads_per_core: u32,
    pub basis: Basis,
}

/// Place a card in the table, or `None` when it cannot be placed.
pub fn family(dev: &MinerGpuDevice) -> Option<Family> {
    let row = |name, basis| Family { name, threads_per_core: THREADS_PER_CORE, basis };
    match dev.vendor.as_str() {
        "amd" => {
            let arch = dev.arch.as_deref()?.to_ascii_lowercase();
            let gfx = arch.strip_prefix("gfx")?;
            Some(if gfx.starts_with("103") {
                row("amd-rdna2", Basis::Measured) // RX 6700 XT, gfx1031
            } else if gfx.starts_with("101") {
                row("amd-rdna1", Basis::Assumed)
            } else if gfx.starts_with("11") {
                row("amd-rdna3", Basis::Assumed)
            } else if gfx.starts_with("12") {
                row("amd-rdna4", Basis::Assumed)
            } else if gfx.starts_with('9') {
                row("amd-gcn5", Basis::Assumed)
            } else {
                row("amd-other", Basis::Assumed)
            })
        }
        "nvidia" => {
            let major: u32 = dev.compute_capability.as_deref()?.split('.').next()?.trim().parse().ok()?;
            let minor: u32 = dev
                .compute_capability
                .as_deref()?
                .split('.')
                .nth(1)
                .and_then(|m| m.trim().parse().ok())
                .unwrap_or(0);
            Some(match (major, minor) {
                (10, _) | (12, _) => row("nvidia-blackwell", Basis::Measured), // RTX 5060 Ti, CC 12.0
                (8, 9) => row("nvidia-ada", Basis::Assumed),
                (8, _) => row("nvidia-ampere", Basis::Assumed),
                (7, 5) => row("nvidia-turing", Basis::Assumed),
                _ => row("nvidia-other", Basis::Assumed),
            })
        }
        // SRBMiner's Intel line has not been seen yet, so there is no core
        // field to read with confidence. SRBMiner tunes these itself.
        _ => None,
    }
}

/// Estimated XelisHash threads for one card, or `None` (SRBMiner tunes).
pub fn estimate_threads(dev: &MinerGpuDevice) -> Option<u32> {
    let fam = family(dev)?;
    let cores = dev.compute_units.filter(|c| *c > 0)?;
    let wanted = cores.saturating_mul(fam.threads_per_core) / STEP * STEP;
    let wanted = wanted.max(STEP);
    Some(match dev.memory_mb {
        // `gpu_threads_for_vram_limit(card, card)` = 90% of the card.
        Some(mb) => wanted.min(gpu_threads_for_vram_limit(mb, Some(mb), XELISHASH_V3_SCRATCHPAD_BYTES)),
        None => wanted,
    })
}

/// One card as saved in the profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfiledGpu {
    pub id: u32,
    pub name: String,
    pub vendor: String,
    pub memory_mb: Option<u32>,
    pub compute_units: Option<u32>,
    pub arch: Option<String>,
    pub compute_capability: Option<String>,
    pub family: Option<String>,
    pub basis: Option<Basis>,
    pub xelis_threads: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GpuProfile {
    pub version: u32,
    pub detected_at_unix: u64,
    pub source: String,
    pub devices: Vec<ProfiledGpu>,
}

pub fn build_profile(devices: &[MinerGpuDevice], now_unix: u64) -> GpuProfile {
    GpuProfile {
        version: 1,
        detected_at_unix: now_unix,
        source: "SRBMiner-MULTI --list-devices".into(),
        devices: devices
            .iter()
            .map(|d| {
                let fam = family(d);
                ProfiledGpu {
                    id: d.id,
                    name: d.name.clone(),
                    vendor: d.vendor.clone(),
                    memory_mb: d.memory_mb,
                    compute_units: d.compute_units,
                    arch: d.arch.clone(),
                    compute_capability: d.compute_capability.clone(),
                    family: fam.as_ref().map(|f| f.name.to_string()),
                    basis: fam.as_ref().map(|f| f.basis),
                    xelis_threads: estimate_threads(d),
                }
            })
            .collect(),
    }
}

impl ProfiledGpu {
    fn to_device(&self) -> MinerGpuDevice {
        MinerGpuDevice {
            id: self.id,
            name: self.name.clone(),
            vendor: self.vendor.clone(),
            memory_mb: self.memory_mb,
            compute_units: self.compute_units,
            arch: self.arch.clone(),
            compute_capability: self.compute_capability.clone(),
        }
    }
}

pub const PROFILE_FILE: &str = "gpu-profile.json";

pub fn profile_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(PROFILE_FILE)
}

/// Save the detected cards. Written only when they changed, so a normal start
/// does not rewrite the file. Failure is logged, never fatal.
pub fn save(path: &Path, devices: &[MinerGpuDevice]) {
    if devices.is_empty() {
        return;
    }
    if load(path).as_deref() == Some(devices) {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match serde_json::to_string_pretty(&build_profile(devices, now)) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                eprintln!("[gpu-profile] could not save {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[gpu-profile] could not serialise: {e}"),
    }
}

/// The saved cards, or `None` when there is no readable profile.
pub fn load(path: &Path) -> Option<Vec<MinerGpuDevice>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let profile: GpuProfile = serde_json::from_str(&raw).ok()?;
    Some(profile.devices.iter().map(ProfiledGpu::to_device).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miners::parse_srbminer_list_devices;

    /// Verbatim from the dev box, 2026-09-17 (SRBMiner-MULTI 3.6.2).
    const DEV_BOX: &str = "OPENCL devices\n\n\
GPU0  [0][0] [06:00.0] : amd_radeon_rx_6700_xt [gfx1031] [12272 MB] [CU: 40] [MaxBuf: 12272 MB]\n\n\
CUDA devices\n\n\
GPU1  [CUDA][0] [0000:01:00.0] : nvidia_geforce_rtx_5060_ti [blackwell] [CC: 12.0] [SM: 36] [16310 MB]\n";

    fn dev(vendor: &str, arch: Option<&str>, cc: Option<&str>, cores: Option<u32>, mb: Option<u32>) -> MinerGpuDevice {
        MinerGpuDevice {
            id: 0,
            name: "card".into(),
            vendor: vendor.into(),
            memory_mb: mb,
            compute_units: cores,
            arch: arch.map(Into::into),
            compute_capability: cc.map(Into::into),
        }
    }

    #[test]
    fn the_dev_box_cards_parse_with_cores_and_architecture() {
        let d = parse_srbminer_list_devices(DEV_BOX);
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].compute_units, d[0].arch.as_deref()), (Some(40), Some("gfx1031")));
        assert_eq!(d[0].compute_capability, None);
        assert_eq!((d[1].compute_units, d[1].arch.as_deref()), (Some(36), Some("blackwell")));
        assert_eq!(d[1].compute_capability.as_deref(), Some("12.0"));
        assert_eq!((d[0].memory_mb, d[1].memory_mb), (Some(12272), Some(16310)));
    }

    /// Both measured cards get at least the 3840 threads measured as enough,
    /// and a quarter or less of what SRBMiner's own tune chose (15360).
    #[test]
    fn the_measured_cards_get_their_estimates() {
        let d = parse_srbminer_list_devices(DEV_BOX);
        assert_eq!(estimate_threads(&d[0]), Some(4352)); // 40 CU x 112, floored to 256
        assert_eq!(estimate_threads(&d[1]), Some(3840)); // 36 SM x 112
        assert_eq!(family(&d[0]).unwrap().basis, Basis::Measured);
        assert_eq!(family(&d[1]).unwrap().name, "nvidia-blackwell");
    }

    #[test]
    fn families_are_placed_by_arch_and_compute_capability() {
        let name = |d: &MinerGpuDevice| family(d).map(|f| f.name);
        assert_eq!(name(&dev("amd", Some("gfx1100"), None, Some(96), None)), Some("amd-rdna3"));
        assert_eq!(name(&dev("amd", Some("gfx1201"), None, Some(64), None)), Some("amd-rdna4"));
        assert_eq!(name(&dev("amd", Some("gfx1010"), None, Some(40), None)), Some("amd-rdna1"));
        assert_eq!(name(&dev("nvidia", None, Some("8.9"), Some(76), None)), Some("nvidia-ada"));
        assert_eq!(name(&dev("nvidia", None, Some("8.6"), Some(46), None)), Some("nvidia-ampere"));
        assert_eq!(name(&dev("nvidia", None, Some("7.5"), Some(40), None)), Some("nvidia-turing"));
        assert_eq!(family(&dev("nvidia", None, Some("8.9"), Some(76), None)).unwrap().basis, Basis::Assumed);
    }

    /// No estimate means SRBMiner tunes itself, exactly as before this module.
    #[test]
    fn a_card_the_table_cannot_place_gets_no_estimate() {
        assert_eq!(estimate_threads(&dev("intel", None, None, Some(32), Some(16000))), None);
        assert_eq!(estimate_threads(&dev("amd", None, None, Some(40), Some(12272))), None); // no arch
        assert_eq!(estimate_threads(&dev("nvidia", None, None, Some(36), Some(16310))), None); // no CC
        assert_eq!(estimate_threads(&dev("amd", Some("gfx1031"), None, None, Some(12272))), None); // no cores
        assert_eq!(estimate_threads(&dev("amd", Some("gfx1031"), None, Some(0), Some(12272))), None);
    }

    #[test]
    fn a_small_card_is_capped_at_90_percent_of_its_memory() {
        // 84 SM x 112 = 9408 -> 9216, but 90% of a 2 GB card holds 3554 -> 3328.
        let small = dev("nvidia", None, Some("8.6"), Some(84), Some(2048));
        assert_eq!(estimate_threads(&small), Some(3328));
        // Unknown memory: the core estimate stands.
        assert_eq!(estimate_threads(&dev("nvidia", None, Some("8.6"), Some(84), None)), Some(9216));
    }

    #[test]
    fn the_profile_round_trips_and_is_not_rewritten_when_unchanged() {
        let dir = std::env::temp_dir().join(format!("pwnda-gpu-profile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = profile_path(&dir);
        let _ = std::fs::remove_file(&path);
        assert_eq!(load(&path), None);

        let d = parse_srbminer_list_devices(DEV_BOX);
        save(&path, &d);
        assert_eq!(load(&path).as_deref(), Some(&d[..]));
        let json = std::fs::read_to_string(&path).unwrap();
        assert!(json.contains("\"xelis_threads\": 4352"), "{json}");
        assert!(json.contains("\"basis\": \"measured\""), "{json}");

        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        save(&path, &d);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
