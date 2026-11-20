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
AppVersion=0.18.4
AppPublisher=KTK
DefaultDirName={autopf}\KTK\QwenMCP
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19045
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=no
OutputDir={#OutputRoot}
OutputBaseFilename=KTK-Qwen-MCP-Setup-0.18.4-TEST-UNSIGNED
Compression=lzma2
SolidCompression=yes
CloseApplications=no
ChangesAssociations=no
SetupLogging=yes
WizardStyle=modern

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{tmp}\KTKPayload"; Flags: recursesubdirs createallsubdirs deleteafterinstall

[Code]
var
  ApprovalOpened: Boolean;

procedure KTKLog(const S: String; const Error, FirstLine: Boolean);
var
  Link: String;
  ErrorCode: Integer;
  Prefix: String;
  CodeStart: Integer;
  I: Integer;
begin
  Prefix := 'KTK_APPROVAL_URL: ';
  if Pos(Prefix, S) = 1 then begin
    Link := Copy(S, Length(Prefix) + 1, Length(S));
    { Fixed issuer/path, fixed-length code and fingerprint; no arbitrary URI. }
    CodeStart := Length('https://qwen125b-mcp.vl-ktk.workers.dev/device/pair/manage#code=') + 1;
    if (Pos('https://qwen125b-mcp.vl-ktk.workers.dev/device/pair/manage#code=', Link) <> 1)
      or (Length(Link) <> CodeStart - 1 + 10 + Length('&fingerprint=') + 16)
      or (Pos('&fingerprint=', Link) <> CodeStart + 10) then
      RaiseException('Unexpected device approval URL');
    for I := CodeStart to CodeStart + 9 do
      if Pos(Link[I], 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') = 0 then
        RaiseException('Invalid device approval code');
    for I := CodeStart + 10 + Length('&fingerprint=') to Length(Link) do
      if Pos(Link[I], 'ABCDEF0123456789') = 0 then
        RaiseException('Invalid device fingerprint');
    if not ApprovalOpened then begin
      ApprovalOpened := True;
      WizardForm.StatusLabel.Caption := 'Один раз разреши подключение в браузере. Коды вводить не нужно.';
      { Critical: never launch an elevated browser from an elevated installer. }
      if not ShellExecAsOriginalUser('open', Link, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode) then
        RaiseException('Could not open pairing page: ' + SysErrorMessage(ErrorCode));
    end;
  end else if (Pos('ONE-TIME CODE:', S) = 1) or (Pos('DEVICE FINGERPRINT:', S) = 1) then begin
    { The code is shown in the browser; avoid saving pairing data in Setup logs. }
  end else if Error then
    Log('KTK error: ' + S)
  else
    Log('KTK: ' + S);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
  PowerShell: String;
  Args: String;
  Mode: String;
  Index: Integer;
  Entrypoint: String;
begin
  if CurStep <> ssPostInstall then Exit;
  { Inno Setup 6 is a 32-bit installer: Sysnative resolves to native System32. }
  PowerShell := ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe');
  Mode := '-Live';
  for Index := 1 to ParamCount do
    if Uppercase(ParamStr(Index)) = '/OFFLINE' then Mode := '-Offline';
  Entrypoint := ExpandConstant('{tmp}\KTKPayload\Run-KTKAcceptance.ps1');
  { A staged but not yet paired first install must resume acceptance, not update. }
  if (Mode = '-Live') and
     FileExists(ExpandConstant('{autopf}\KTK\QwenMCP\MANIFEST.json')) and
     FileExists(ExpandConstant('{commonappdata}\KTK\QwenMCP\state\enrollment.json')) then begin
    Entrypoint := ExpandConstant('{tmp}\KTKPayload\Maintain-KTKMCP.ps1');
    Args := '-NoProfile -ExecutionPolicy Bypass -File "' + Entrypoint +
      '" -Action Update -PackagePath "' + ExpandConstant('{tmp}\KTKPayload') +
      '" -Resume -InstallerApproved';
    WizardForm.StatusLabel.Caption := 'Обновление существующей KTK Qwen MCP без повторной привязки...';
  end else
    Args := '-NoProfile -ExecutionPolicy Bypass -File "' + Entrypoint + '" ' + Mode;
  ApprovalOpened := False;
  { Sysnative avoids WOW64 redirection without newer Inno 7 helper APIs. }
  if not ExecAndLogOutput(PowerShell, Args, '', SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode, @KTKLog) then
    RaiseException('Could not run KTK acceptance; see Windows error ' + IntToStr(ExitCode));
  if ExitCode <> 0 then
    RaiseException('KTK setup/update failed; original installation may require recovery.');
end;
