; Uplinq Studio used to be called FTP Studio, and came with its own installer that put it in
; %LOCALAPPDATA%\Programs\FTP Studio. Installing Uplinq Studio removes that old copy, its
; shortcuts and its entry in "Installed apps". Saved sites and settings are kept: both
; versions use the same data folder, so they carry over.

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$LOCALAPPDATA\Programs\FTP Studio\FTP Studio.exe" 0 no_old_copy
    ; The old app may still be open; it has to close for its files to go.
    nsExec::Exec 'taskkill /IM "FTP Studio.exe" /F'
    Sleep 500
    Delete "$LOCALAPPDATA\Programs\FTP Studio\FTP Studio.exe"
    Delete "$LOCALAPPDATA\Programs\FTP Studio\Uninstall FTP Studio.exe"
    RMDir "$LOCALAPPDATA\Programs\FTP Studio"
    Delete "$DESKTOP\FTP Studio.lnk"
    Delete "$SMPROGRAMS\FTP Studio.lnk"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FTPStudio"
  no_old_copy:
!macroend
