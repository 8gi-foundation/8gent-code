; installer.nsi - NSIS installer for 8gent Code (Windows)
;
; Wraps the single-file `8gent.exe` produced by `bun build --compile
; --target=bun-windows-x64` into a per-user installer. No admin rights
; required: installs to %LOCALAPPDATA%\Programs\8gent and adds that
; directory to the *user* PATH. Ships an uninstaller.
;
; Needs only stock NSIS 3 (MUI2) - no third-party plugins or headers. PATH
; is edited idempotently via PowerShell's [Environment]::SetEnvironmentVariable
; against the User scope, which persists and broadcasts WM_SETTINGCHANGE.
;
; Build (on Windows, with NSIS installed):
;   makensis /DEIGHT_VERSION=0.17.3 /DEIGHT_EXE=..\..\dist\bin\8gent-windows-x64.exe packaging\windows\installer.nsi
;
; Output: 8gent-setup-<version>-x64.exe next to this script.
;
; Authenticode signing is applied to the *output* installer by the packaging
; script (scripts\package-windows.ps1), opt-in and skip-if-absent. This .nsi
; embeds no certificate. See SIGNING.md.

Unicode true

!ifndef EIGHT_VERSION
  !define EIGHT_VERSION "0.0.0"
!endif
!ifndef EIGHT_EXE
  !define EIGHT_EXE "..\..\dist\bin\8gent-windows-x64.exe"
!endif

!define APP_NAME "8gent Code"
!define APP_PUBLISHER "8GI Foundation"
!define APP_URL "https://8gent.dev"
!define APP_DIRNAME "8gent"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_DIRNAME}"

!include "MUI2.nsh"

Name "${APP_NAME}"
OutFile "8gent-setup-${EIGHT_VERSION}-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_DIRNAME}"
InstallDirRegKey HKCU "Software\${APP_DIRNAME}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

VIProductVersion "${EIGHT_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion" "${EIGHT_VERSION}"
VIAddVersionKey "LegalCopyright" "Apache-2.0"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Idempotently add $INSTDIR to the User PATH via PowerShell. Guards against
; duplicate entries so re-installs do not grow PATH without bound.
!macro AddToUserPath dir
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$p = [Environment]::GetEnvironmentVariable(\"PATH\", \"User\"); $$d = \"${dir}\"; if (-not (($$p -split \";\") -contains $$d)) { if ([string]::IsNullOrEmpty($$p)) { [Environment]::SetEnvironmentVariable(\"PATH\", $$d, \"User\") } else { [Environment]::SetEnvironmentVariable(\"PATH\", $$p.TrimEnd(\";\") + \";\" + $$d, \"User\") } }"'
!macroend

; Remove $INSTDIR from the User PATH on uninstall.
!macro RemoveFromUserPath dir
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$p = [Environment]::GetEnvironmentVariable(\"PATH\", \"User\"); if ($$p) { $$new = ($$p -split \";\" | Where-Object { $$_ -and $$_ -ne \"${dir}\" }) -join \";\"; [Environment]::SetEnvironmentVariable(\"PATH\", $$new, \"User\") }"'
!macroend

Section "Install"
  SetOutPath "$INSTDIR"
  ; Land the compiled binary as 8gent.exe so `8gent` works on the CLI.
  File /oname=8gent.exe "${EIGHT_EXE}"

  !insertmacro AddToUserPath "$INSTDIR"

  WriteRegStr HKCU "Software\${APP_DIRNAME}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Add/Remove Programs entry.
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${EIGHT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${APP_URL}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\8gent.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  !insertmacro RemoveFromUserPath "$INSTDIR"
  Delete "$INSTDIR\8gent.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_DIRNAME}"
SectionEnd
