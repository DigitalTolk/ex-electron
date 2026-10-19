; The app adds itself to Windows' Startup apps on first launch
; (src/lib/login-item.ts), named by its AppUserModelId. Remove that entry on
; uninstall so the list keeps no row pointing at a deleted ex.exe; an update
; runs the old uninstaller too, and must keep it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.digitaltolk.ex.electron"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.digitaltolk.ex.electron"
  ${endIf}
!macroend
