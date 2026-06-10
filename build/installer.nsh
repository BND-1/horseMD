; Custom NSIS hooks for HorseMD.
;
; 1) Adds an "Open with HorseMD" entry to the right-click menu of folders, so a
;    whole directory can be opened as a workspace straight from Explorer.
; 2) Makes uninstall SURGICAL: it removes only the files we installed, so a file
;    the user saved inside the install folder (e.g. a Markdown note next to the
;    app) is preserved instead of being wiped by a blanket "RMDir /r $INSTDIR".
;
; Registry entries are written under HKCU\Software\Classes (per-user) so they
; work without admin rights, matching the per-user install.

!macro customInstall
  ; Right-clicking a folder
  WriteRegStr HKCU "Software\Classes\Directory\shell\HorseMD" "" "Open with HorseMD"
  WriteRegStr HKCU "Software\Classes\Directory\shell\HorseMD" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\HorseMD\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Right-clicking the empty background inside a folder
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\HorseMD" "" "Open with HorseMD"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\HorseMD" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\HorseMD\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\HorseMD"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\HorseMD"
!macroend

; Replaces electron-builder's default "RMDir /r $INSTDIR" — which would wipe the
; WHOLE install folder. Because the install directory is now user-selectable
; (allowToChangeInstallationDirectory), a user might install into a folder that
; also holds their own files. So removal is SURGICAL in BOTH cases — update and
; real uninstall — deleting only the files we shipped. The wildcard deletes cover
; Electron's entire payload (exe, *.dll/*.pak/*.bin/*.dat, locales/, resources/
; incl. app.asar, swiftshader/), so updates still get a clean slate; anything the
; user added (notes, etc.) is left untouched, and the final non-recursive RMDir
; removes the folder only if it ends up empty.
!macro hmRemoveShippedFiles
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.txt"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\swiftshader"
!macroend

!macro customRemoveFiles
  ${if} ${isUpdated}
    ; Update / overwrite-install: surgical removal (keep user files), then the
    ; installer writes the new version's files back in.
    !insertmacro hmRemoveShippedFiles
  ${else}
    ; Real uninstall: same surgical removal, then drop the folder if it's empty.
    !insertmacro hmRemoveShippedFiles
    RMDir "$INSTDIR"
  ${endif}
!macroend
