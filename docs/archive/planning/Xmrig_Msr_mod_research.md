# XMRig MSR mod failures on Windows: causes, fixes, and the developer playbook

The MSR mod error on Windows is, at its core, a **driver-trust problem with the 17-year-old WinRing0x64.sys driver that XMRig still ships**, not a privilege problem. Running as Administrator no longer guarantees a kernel driver loads, because Windows 11 22H2+ enforces Microsoft's Vulnerable Driver Blocklist independently of UAC, and WinRing0 is on that list. Understanding this distinction unlocks every workaround below — and the only durable fix for a developer is to ship a **custom, attestation-signed kernel driver** with a tightly whitelisted MSR IOCTL, then run XMRig with MSR mod *disabled* on top of values you've already written.

The user's reported 6× hashrate cliff (≈12,000 → ≈2,000 H/s) is real but **not purely an MSR-mod symptom**. Documented MSR-mod gains are 5–10% on Ryzen and 15–30% on Intel, so a 6× drop almost certainly means **MSR mod and 1 GB huge pages and/or NUMA pinning are all failing simultaneously** on the same security gate. Fix the driver problem and the page/NUMA problems usually unlock with it.

## What MSR mod actually does and why a 6× drop is suspicious

RandomX intentionally accesses memory at random addresses, which makes hardware prefetchers actively harmful — they pollute the L1/L2 caches with speculative lines the algorithm never uses. XMRig's MSR mod writes a small set of Model Specific Registers to **disable the L1 DCU prefetcher, the L1 DCU-IP prefetcher, the L2 prefetcher, and the L2 adjacent-line prefetcher**, and on AMD also tweaks load-store and op-cache configuration registers.

The exact writes XMRig issues (visible in logs as preset names like `intel`, `ryzen_17h`, `ryzen_19h`, `ryzen_1Ah_zen5`):

| CPU family | MSR | Value | Effect |
|---|---|---|---|
| Intel (Nehalem+) | `0x1A4` | `0xF` | Disables 4 prefetcher classes |
| Ryzen Zen1/Zen2 | `0xC0011020`, `0xC0011021`, `0xC0011022`, `0xC001102B` | preset values | DC/IC config tuned for RandomX |
| Ryzen Zen3+ | same MSRs | different preset (`0x4480000000000` etc.) | Adds favorable cache hints |
| First-gen Zen | `0xC001102B = 0x1808cc16` | disables op-cache | Works around silicon errata |

**Documented hashrate gains** from MSR mod alone: Intel i7-7700K 537 → 687 H/s (~30%), Ryzen 7 3700X 9100 → 9670 H/s (~6%). Kryptex's own docs claim "10–30%". Linuxreviews benchmarks call the Ryzen gain "very small." A genuine 6× cliff therefore implies a **compound failure**: when WinRing0 is blocked, the same admin/HVCI gating chain often also blocks 1 GB huge-page allocation and NUMA-aware affinity — and on a high-core-count Ryzen/Threadripper losing all three simultaneously can produce that magnitude of drop. GitHub issue #3208 documents a 64-core Threadripper 5995WX hashing at **1,800 H/s instead of ~50,000 H/s** (≈25× drop) in exactly this configuration.

The exact log line XMRig emits on failure is **`msr FAILED TO APPLY MSR MOD, HASHRATE WILL BE LOW`**, often preceded by one of: `failed to start WinRing0 driver, error 5` (not admin), `error 183` (service collision), `error 395` / `error 1275` / `error 577` (Vulnerable Driver Blocklist hit), or `cannot set MSR 0xc0011020 to 0x0` (driver loaded but VBS intercepted the WRMSR).

## Why Administrator and Defender exclusions are insufficient

UAC controls user-mode privilege; **kernel driver loading is decided by Code Integrity, which sits below UAC**. Five layered defenses each block WinRing0 independently, and most are now default-on:

1. **Microsoft Vulnerable Driver Blocklist** (Win11 22H2+, KB5018482 on Win10) ships as a signed WDAC policy in `%windir%\System32\CodeIntegrity\SiPolicy.p7b`. WinRing0 1.2.0 is matched by hash, by file attribute, and by signing-cert ("Noriyuki Miyazaki / OpenLibSys.org"). Hits log Event ID 3023/3033/3077 in the CodeIntegrity Operational log.
2. **Memory Integrity / HVCI** (Win11 default on supported hardware) verifies kernel images via the hypervisor; WinRing0 lacks the NX-section attributes HVCI requires and is rejected at load. When HVCI is on, the blocklist toggle is **greyed out and force-enabled**.
3. **Smart App Control** enforces blocklist + reputation independently of HVCI. Once disabled, it cannot be re-enabled without OS reinstall.
4. **CVE-2020-14979** (arbitrary kernel privilege escalation through `IOCTL_OLS_WRITE_MSR` with a NULL DACL) is the reason Microsoft added WinRing0 to the blocklist in the first place. It is also why Defender flags both `xmrig.exe` (as `PUA:Win32/CoinMiner`) and `WinRing0x64.sys` (as **`VulnerableDriver:WinNT/Winring0`**).
5. **Cross-signed driver trust removed in April 2026** further narrows the path forward; only EV-signed, attestation-signed drivers reliably load on Windows 11 24H2/25H2/26H1.

Even Defender exclusions for the XMRig folder don't help with #1–#3, because **Code Integrity blocks the load before Defender's exclusion list is consulted**. The exclusions only prevent the file from being quarantined; they do not authorize the kernel to load it.

## How Unmineable, Kryptex, and NiceHash actually do it

The investigation produced a deflating answer: **all of them ship the same 2008-Verisign-signed WinRing0x64.sys that vanilla XMRig ships, and they install it the same way XMRig does — via `CreateService(SERVICE_KERNEL_DRIVER)` for service `WinRing0_1_2_0`, then `IOCTL_WRITE_MSR`**. There is no novel driver, no custom EV-signed MSR kernel module, and no SYSTEM-context pre-loader that primes the driver before XMRig launches. Trellix's December 2025 cryptojacking-malware teardown confirms commodity miners use literally identical code.

Their advantages over a raw `xmrig.exe` execution are operational, not technical:

- **Signed installer chain** — Kryptex and NiceHash use DigiCert/H-BIT EV-signed installers, which earn higher SmartScreen and Defender reputation, reducing the chance the bundled `xmrig.exe` and `WinRing0x64.sys` are deleted at install time.
- **Guaranteed elevation** — installer manifests force Run-as-Administrator on every launch (NiceHash via the `nhqmservice.exe` autostart Windows service, Kryptex via Squirrel auto-elevation, Unmineable via Electron). Users who download xmrig.zip and double-click from Explorer often run with a Medium-IL token and trip error 5.
- **Hand-holding documentation** — Kryptex's "FAILED TO APPLY MSR MOD" KB article, NiceHash's QuickMiner FAQ, and Unmineable's miner setup pages all explicitly walk users through Defender exclusions, HVCI/Core Isolation disablement, and conflicting-app shutdown. NiceHash literally states their driver "has been signed on Saturday, 26 July 2008 by Noriyuki MIYAZAKI" — they confirm publicly that they bundle the same legacy file.
- **Service-collision avoidance** — Kryptex's docs instruct users to delete `HKLM\SYSTEM\CurrentControlSet\Services\WinRing0_1_2_0` if it conflicts with HWiNFO/MSI Afterburner/OpenRGB/Cooler Master MasterPlus.

The only proprietary signed driver in this ecosystem is NiceHash's **`Excavator`** GPU driver (signed by H-BIT d.o.o.), which has nothing to do with MSR. **No major mining wrapper has solved the modern HVCI/SAC problem** — they are all in the same slow decline as raw XMRig, waiting for an EV-signed replacement that has not materialized despite XMRig issue #3573 (Oct 2024) raising the alarm.

## What the community actually does to make it work

Distilling roughly fifteen GitHub issues (#1891, #1937, #2061, #2305, #2475, #2626, #2673, #2795, #2844, #3206, #3370, #3573, #3697, #3701, #3721) plus the Kryptex and NiceHash KBs, the empirically ranked fixes are:

**Tier 1, highest success rate.** Run xmrig.exe as Administrator (right-click → Properties → Compatibility → "Run as administrator" so it's permanent). Add Defender folder *and* file exclusions for the XMRig directory and `WinRing0x64.sys` specifically (`Add-MpPreference -ExclusionPath ...`). Disable **Memory Integrity** in Windows Security → Device security → Core isolation, and reboot. Then disable the Vulnerable Driver Blocklist with PowerShell:

```
Set-MpPreference -EnableVulnerableDriverBlocklist $false
```

That last toggle is greyed out while HVCI or Smart App Control is on, which is why HVCI must come off first.

**Tier 2, for service collisions.** Errors 183 / 1072 / "already exists with a different service name" are caused by HWiNFO, MSI Afterburner, NiceHashMiner ≥3.0.6.6 (in particular, NHM's "Device Status Monitoring" feature — disable it per NiceHash issue #2537), Cooler Master MasterPlus, ASUS Armoury Crate, OpenRGB, ThrottleStop, Ryzen Master, CPU-Z, AIDA64, FanControl, or Razer Synapse all installing their own copy of the same driver. The standard purge is:

```
sc stop WinRing0_1_2_0
sc delete WinRing0_1_2_0
```

then reboot, then close the conflicting app, then run XMRig.

**Tier 3, last resort.** Disable Secure Boot in BIOS (XMRig docs reference issue #1891). Disable VBS entirely with `bcdedit /set hypervisorlaunchtype off` plus the four `HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard` and `\CI\Config` registry keys set to 0. Run XMRig as `NT AUTHORITY\SYSTEM` via `psexec -s -i xmrig.exe` (helps with some AppLocker setups but does *not* bypass HVCI). Manually pre-set the AMD MSRs externally with **RW-Everything** (`Rw.sys`) or ThrottleStop, then run XMRig with `"wrmsr": false` to skip its driver load entirely — MSR values persist until reboot, so this works. As a final fallback, accept the ~5–15% hashrate loss with `--no-msr` (or `"randomx": { "wrmsr": false }`).

A re-signed WinRing0 fork at **github.com/GermanAizek/WinRing0** patches CVE-2020-14979 with a proper SDDL ACL, but **no publicly distributed EV-signed binary** of the fork exists. Self-signed builds require test-signing mode, which forfeits Secure Boot.

## What XMRig version-specific information matters

MSR mod was introduced in **XMRig 5.2/5.3.0** (early 2020) advertising a "5–10% RandomX boost". Version 6.5.x added auto-cleanup of the WinRing0 service on exit, which inadvertently created the error-1072 "service marked for deletion" trap when XMRig crashed mid-run. Versions 6.13.x onward (Oct 2021) coincide with the Defender signature update that began flagging WinRing0, and 6.15.x–6.16.x added clearer error messages distinguishing "driver failed to load" from "driver loaded but MSR write rejected by VBS." Critically, **issue #3573 (Oct 30, 2024) was closed without resolution**: XMRig will not ship an updated driver because no EV-signed re-signed WinRing0 exists, and the project considers driver maintenance out of scope. **There is no XMRig version that solves this problem at the application level.**

## The proper developer architecture for a Windows wrapper

If you are building a commercial Windows app that bundles XMRig and needs reliable MSR mod, the only architecture that survives Windows 11 22H2+, HVCI, Smart App Control, and the April 2026 cross-signed cutoff is to **ship your own attestation-signed MSR driver and pre-apply the MSRs before launching XMRig**. The recommended pipeline:

1. **Acquire an EV code-signing certificate** (DigiCert ~$409/yr, Sectigo $290–$499/yr, SSL.com from $249/yr). Identity verification takes 1–4 weeks; the cert is delivered on a FIPS 140-2 Level 2 USB token. Organizations only — no individual EVs.
2. **Enroll in Microsoft Partner Center / Hardware Dev Center** with the EV cert (free since the $99 fee was eliminated). Microsoft Trusted Signing ($9.99/mo) does **not** currently substitute for an EV cert at Hardware Dev Center enrollment, though it can sign your user-mode binaries.
3. **Build a minimal KMDF driver** (~150–200 lines based on Microsoft's `Echo` sample at `github.com/microsoft/Windows-driver-samples`) exposing only `IOCTL_RDMSR` and `IOCTL_WRMSR`, with the device created via `IoCreateDeviceSecure` with SDDL `D:P(A;;GA;;;SY)(A;;GA;;;BA)` so only SYSTEM and Admins can open the handle. **Hard-whitelist** the MSR indices you need (`0x1A4` Intel; `0xC0011020`–`0xC001102B` AMD) — refusing arbitrary MSRs dramatically lowers your odds of being added to the Vulnerable Driver Blocklist, which has eaten WinRing0, RTCore64, AsIO, AMDRyzenMasterDriver ≤2.0, inpoutx64, ALSysIO64, CPUZ, and others.
4. **Submit the CAB (driver + INF + symbols) for Microsoft attestation signing** via Partner Center. Turnaround is typically minutes to hours; Oracle has open-sourced an automation CLI (`blogs.oracle.com/linux/automatic-attestation-signing`).
5. **Ship a user-mode Windows service running as LocalSystem** that, before launching XMRig, calls `StartService` on your driver, opens `\\.\YourMsrSvc`, iterates logical CPUs with `SetThreadAffinityMask`, issues `IOCTL_WRMSR` for the four AMD or one Intel MSR, then closes the handle. **Do not delete the service** — leave it registered so HWiNFO/AIDA cannot race you for the WinRing0 name on next launch. Re-apply on power-state resume by hooking `PowerRegisterSuspendResumeNotification`.
6. **Spawn unmodified `xmrig.exe`** with `"randomx": { "wrmsr": false, "rdmsr": false }` so XMRig skips its own WinRing0 install path entirely. The MSRs are already set; XMRig benefits transparently and produces no driver-related log noise. This also keeps you on the right side of XMRig's GPLv3 (mere aggregation of an unmodified upstream binary).
7. **Sign your installer, EXEs, and DLLs** with the EV cert (or Microsoft Trusted Signing for user-mode binaries) to clear SmartScreen.
8. **Maintain a no-driver fallback** that runs XMRig with `wrmsr: false` and accepts the 5–15% AMD or 15–30% Intel hashrate penalty — for customers whose policies block all third-party drivers.

The architectural insight that makes this clean is that **MSRs are write-once-per-boot per logical CPU**: nothing requires XMRig itself to hold the driver handle. Pre-apply, then run XMRig with MSR mod off, and you get full hashrate without ever touching WinRing0.

## What this means in practice

The MSR-mod error is no longer a configuration problem the user can reliably defeat on a default-configured Windows 11 system; it is a fundamental incompatibility between XMRig's 2008-era driver and Microsoft's 2022-era kernel-trust model. Casual users can still squeeze through the cracks by running as Administrator, excluding files from Defender, disabling Memory Integrity, and clearing service collisions — and that is precisely the gauntlet Kryptex and NiceHash document for their users. But that gauntlet narrows with every Windows release. The only path that scales is the one Microsoft has been telegraphing for a decade: **own your kernel code, sign it under attestation, restrict its IOCTL surface, and stop relying on a 17-year-old driver everybody ships in a folder marked `bin\WinRing0\`**. For a developer, that is roughly $400 and three weeks of cert-acquisition work plus a weekend of KMDF code — and it is the only design that will still work on Windows 11 26H1 in late 2026.