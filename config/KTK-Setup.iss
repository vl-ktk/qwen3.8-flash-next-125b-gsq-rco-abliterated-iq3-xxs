; Single executable test candidate, built only from verified ZIP contents.
; No uninstaller is registered here: pairing must be remotely revoked before
; credentials can be removed by Maintain-KTKMCP.ps1.
#ifndef SourceRoot
  #error SourceRoot must be passed to ISCC
#endif
#ifndef OutputRoot
  #error OutputRoot must be passed to ISCC
#endif

[Setup]
AppId={{F087E1C8-6597-4DE8-960B-38D903A6E3BE}
AppName=KTK Qwen MCP (Acceptance Candidate)
AppVersion=0.18.0
AppPublisher=KTK
DefaultDirName={autopf}\KTK\QwenMCP
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
MinVersion=10.0.19045
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=no
OutputDir={#OutputRoot}
OutputBaseFilename=KTK-Qwen-MCP-Setup-0.18.0-TEST-UNSIGNED
Compression=lzma2
SolidCompression=yes
CloseApplications=no
ChangesAssociations=no
SetupLogging=yes
WizardStyle=modern

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{tmp}\KTKPayload"; Flags: recursesubdirs createallsubdirs deleteafterinstall

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
  PowerShell: String;
  Args: String;
begin
  if CurStep <> ssPostInstall then Exit;
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Args := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\KTKPayload\Run-KTKAcceptance.ps1') + '" -Live';
  if not Exec(PowerShell, Args, '', SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode) then
    RaiseException('Could not run KTK acceptance; see Windows error ' + IntToStr(ExitCode));
  if ExitCode <> 0 then
    RaiseException('KTK acceptance failed; open KTK-MCP-Test report on Desktop.');
end;
