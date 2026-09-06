; PwndaWallet — NSIS installer hooks
;
; Wired via `bundle.windows.nsis.installerHooks` in tauri.conf.json. Tauri
; inserts these macros into its generated installer.nsi at fixed points; see
; `!ifmacrodef NSIS_HOOK_*` in target/release/nsis/x64/installer.nsi.
;
; ## Why this file exists
;
; Windows shipped two installers until 2026-09-06: an MSI and an NSIS .exe,
; built from the same binary. Only the .exe can be used by the in-app updater
; (an MSI in-place upgrade depends on UpgradeCode + version rules; NSIS simply
; overwrites the install dir — see scripts/make-updater-manifest.mjs), so the
; MSI was dropped and the .exe became the single Windows installer.
;
; But the MSI carried five WiX custom actions the .exe had none of, four of
; them uninstall cleanup. Dropping the MSI without porting them would have
; traded a redundant installer for worse uninstall hygiene: every .exe
; uninstall was already leaving behind an elevated scheduled task, the
; WinRing0_1_2_0 kernel driver service, Defender exclusions, and the miner
; binaries under AppData. That was true BEFORE the consolidation too — .exe
; users never had this cleanup — so this closes a pre-existing gap rather than
; merely preserving parity.
;
; ## What is NOT ported, and why
;
; The MSI's install-time `ClearWinRing0Collision` (a defensive `sc stop/delete`
; of a WinRing0 registration left by HWiNFO / Afterburner / Ryzen Master) is
; deliberately absent. The MSI could afford it because it ran perMachine and
; was already elevated; this installer is `installMode: currentUser` and runs
; unelevated, so porting it would add a UAC prompt to every install. It is also
; redundant: xmrig-launcher.cmd already does the same `sc stop`/`sc delete` on
; every mining start, inside the elevated scheduled task, with no UAC. Paying a
; UAC prompt at install for work the runtime does for free is a bad trade.

!macro NSIS_HOOK_PREUNINSTALL
  ; $UpdateMode is Tauri's own flag, set from the `/UPDATE` argument the
  ; installer passes when it runs the OLD uninstaller during an update
  ; (installer.nsi: `${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE"`).
  ;
  ; Guarding on it is the direct equivalent of the MSI's
  ; `REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE` condition. Without it, every
  ; auto-update would delete the mining scheduled task and push the user back
  ; through the first-mining-start UAC prompt — turning a silent update into a
  ; visible interruption for anyone who mines.
  ${If} $UpdateMode <> 1
  ${AndIf} ${FileExists} "$INSTDIR\nsis\cleanup-uninstall.ps1"
    DetailPrint "Removing mining runtime (scheduled task, driver service, AV exclusions)…"
    ; The script decides for itself whether elevation is needed, and only asks
    ; for it when there is actually something machine-level to remove — so a
    ; user who never enabled mining sees no UAC prompt at all.
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\nsis\cleanup-uninstall.ps1" -InstallDir "$INSTDIR"'
    Pop $0
    ; Return value intentionally discarded. Cleanup is best-effort: a declined
    ; UAC prompt, a Defender-managed-by-policy machine, or a missing
    ; PowerShell must not fail the uninstall.
  ${EndIf}
!macroend
