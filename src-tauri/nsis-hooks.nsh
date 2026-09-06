; NSIS Hooks for Multi-Chain Wallet
; Prompts user to add Windows Defender exclusions during installation
; Note: installMode "both" ensures the installer is already running elevated (admin)

!macro NSIS_HOOK_PREINSTALL
  ; Ask user if they want to add Windows Defender exclusions
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Mining software is often flagged by Windows Defender as a false positive.$\n$\n\
    Would you like to add Windows Defender exclusions for the wallet installation directory?$\n$\n\
    This prevents Defender from quarantining mining executables." \
    IDYES AddExclusions IDNO SkipExclusions

  AddExclusions:
    ; Already running elevated via installMode "both" — run PowerShell directly
    nsExec::ExecToLog 'powershell -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath ''$INSTDIR''; Add-MpPreference -ExclusionProcess ''$INSTDIR\xmrig.exe''; Add-MpPreference -ExclusionProcess ''$INSTDIR\lolMiner.exe''; Add-MpPreference -ExclusionProcess ''$INSTDIR\SRBMiner-MULTI.exe''"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONINFORMATION \
        "Could not add Defender exclusions. You may need to add them manually.$\n\
        Go to Windows Security > Virus & threat protection > Exclusions.$\n\
        Add the folder: $INSTDIR"
    ${EndIf}
    Goto EndExclusions

  SkipExclusions:
  EndExclusions:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Nothing needed post-install
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Nothing needed pre-uninstall
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up Defender exclusions on uninstall (already elevated)
  nsExec::ExecToLog 'powershell -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath ''$INSTDIR''; Remove-MpPreference -ExclusionProcess ''$INSTDIR\xmrig.exe''; Remove-MpPreference -ExclusionProcess ''$INSTDIR\lolMiner.exe''; Remove-MpPreference -ExclusionProcess ''$INSTDIR\SRBMiner-MULTI.exe''"'
!macroend
