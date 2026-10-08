!macro customUnInstall
  ; Autostart is enabled from the app (Electron setLoginItemSettings).
  ; Remove entries of the current and the pre-rename versions.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LLTasker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "LLTasker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.abobacda.lltasker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.abobacda.lltasker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Forge Tasks"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Forge Tasks"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.forge.forgetasks"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.forge.forgetasks"
!macroend
