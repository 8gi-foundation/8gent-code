; NSIS installer for the 8gent Model Proxy (Windows x64).
;
; Build (on Windows or via `makensis` on any host, after compiling the binary):
;   makensis -DPROXY_BIN=..\..\dist\8gent-proxy-win-x64.exe 8gent-proxy.nsi
;
; Produces 8gent-proxy-setup.exe. Optionally installs a background Windows
; service via WinSW (see winsw-service.xml) when /SERVICE is passed on the
; command line.

!include "FileFunc.nsh"

!ifndef PROXY_BIN
  !define PROXY_BIN "..\..\dist\8gent-proxy-win-x64.exe"
!endif

!define APPNAME "8gent Proxy"
!define COMPANY "8GI Foundation"
!define VERSION "0.1.0"

Name "${APPNAME}"
OutFile "8gent-proxy-setup.exe"
InstallDir "$PROGRAMFILES64\8gentProxy"
InstallDirRegKey HKLM "Software\${COMPANY}\8gentProxy" "InstallDir"
RequestExecutionLevel admin
Unicode true

Var INSTALL_SERVICE

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

; Parse /SERVICE from the command line to opt into the background service.
Function .onInit
  StrCpy $INSTALL_SERVICE "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/SERVICE" $R1
  IfErrors +2 0
  StrCpy $INSTALL_SERVICE "1"
FunctionEnd

Section "8gent Proxy" SecMain
  SetOutPath "$INSTDIR"
  File "/oname=8gent-proxy.exe" "${PROXY_BIN}"

  ; Optional background service via WinSW. WinSW.exe is fetched by the release
  ; workflow and renamed to 8gent-proxy-service.exe alongside its XML config.
  StrCmp $INSTALL_SERVICE "1" 0 skipService
    File /nonfatal "8gent-proxy-service.exe"
    File /nonfatal "8gent-proxy-service.xml"
    IfFileExists "$INSTDIR\8gent-proxy-service.exe" 0 skipService
      nsExec::ExecToLog '"$INSTDIR\8gent-proxy-service.exe" install'
      nsExec::ExecToLog '"$INSTDIR\8gent-proxy-service.exe" start'
  skipService:

  WriteRegStr HKLM "Software\${COMPANY}\8gentProxy" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\8gentProxy" \
    "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\8gentProxy" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\8gentProxy" \
    "Publisher" "${COMPANY}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\8gentProxy" \
    "UninstallString" "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\8gent-proxy-service.exe" 0 noService
    nsExec::ExecToLog '"$INSTDIR\8gent-proxy-service.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\8gent-proxy-service.exe" uninstall'
  noService:
  Delete "$INSTDIR\8gent-proxy.exe"
  Delete "$INSTDIR\8gent-proxy-service.exe"
  Delete "$INSTDIR\8gent-proxy-service.xml"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\8gentProxy"
  DeleteRegKey HKLM "Software\${COMPANY}\8gentProxy"
SectionEnd
