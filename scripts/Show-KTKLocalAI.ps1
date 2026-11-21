# Launched by Setup.exe as its ORIGINAL interactive user, never LocalService
# or the elevated administrator. The end user never needs PowerShell commands.
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$payload = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $payload 'bin\node.exe'
$entry = Join-Path $payload 'Install-KTKLocalAI.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'localai_payload_missing' }
if ($CheckOnly) {
    $plan = & $node $entry --plan | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $plan.status -ne 'planned_no_changes' -or $plan.phases.Count -ne 5) { throw 'localai_plan_invalid' }
    Write-Output 'Local AI GUI preflight PASS: no installation, no download, no UI opened.'
    return
}
if (-not [Environment]::UserInteractive -or -not $env:LOCALAPPDATA) { throw 'interactive_user_required' }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'KTK Qwen 125B — установка локальной модели'
$form.Width = 660
$form.Height = 280
$form.StartPosition = 'CenterScreen'
$form.MinimizeBox = $true
$form.MaximizeBox = $false
$form.FormBorderStyle = 'FixedDialog'

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Установка Qwen 125B — всё автоматически'
$title.AutoSize = $false
$title.Location = [System.Drawing.Point]::new(20, 22)
$title.Size = [System.Drawing.Size]::new(605, 33)
$title.Font = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($title)

$state = New-Object System.Windows.Forms.Label
$state.Text = 'Подготовка... Это может занять несколько часов из-за загрузки модели ~77 ГБ.'
$state.Location = [System.Drawing.Point]::new(20, 70)
$state.Size = [System.Drawing.Size]::new(610, 55)
$form.Controls.Add($state)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Minimum = 0
$progress.Maximum = 100
$progress.Value = 0
$progress.Location = [System.Drawing.Point]::new(20, 133)
$progress.Size = [System.Drawing.Size]::new(610, 23)
$form.Controls.Add($progress)

$note = New-Object System.Windows.Forms.Label
$note.Text = 'Можно отменить установку и дождаться безопасной остановки; частично загруженные файлы сохранятся.'
$note.Location = [System.Drawing.Point]::new(20, 163)
$note.Size = [System.Drawing.Size]::new(610, 31)
$form.Controls.Add($note)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Отменить'
$close.Enabled = $true
$close.Location = [System.Drawing.Point]::new(510, 204)
$close.Size = [System.Drawing.Size]::new(120, 31)
$close.Add_Click({
    if ($script:finished -or $null -eq $script:child -or $script:child.HasExited) {
        $form.Close()
    } elseif (-not $script:cancelRequested) {
        $answer = [System.Windows.Forms.MessageBox]::Show(
            'Отменить локальную установку? Уже загруженные части модели останутся для повторной попытки. MCP продолжит работать.',
            'KTK Qwen 125B', [System.Windows.Forms.MessageBoxButtons]::YesNo)
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            $script:cancelRequested = $true
            $close.Enabled = $false
            $state.Text = 'Отмена запрошена. Ожидаем безопасного этапа остановки...'
        }
    }
})
$form.Controls.Add($close)

$statusFile = Join-Path $env:LOCALAPPDATA 'KTK\LocalAI\status.json'
$resultFile = Join-Path $env:LOCALAPPDATA 'KTK\LocalAI\result.json'
$cancelFile = Join-Path $env:LOCALAPPDATA 'KTK\LocalAI\cancel-request.txt'
$script:child = $null
$script:successful = $false
$script:cancelled = $false
$script:finished = $false
$script:cancelRequested = $false
$script:cancelWritten = $false
$script:activeRunId = $null
$script:shownUtc = [DateTime]::UtcNow
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 750
$timer.Add_Tick({
    if (Test-Path -LiteralPath $statusFile -PathType Leaf) {
        try {
            $current = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
            if ($current.status -eq 'running') {
                if ($current.run_id -match '^[0-9a-f]{32}$' -and
                    [DateTimeOffset]::Parse([string]$current.at).UtcDateTime -ge $script:shownUtc) {
                    $script:activeRunId = [string]$current.run_id
                }
                if ($null -ne $current.percent) { $progress.Value = [Math]::Max(0, [Math]::Min(100, [int]$current.percent)) }
                $state.Text = 'Этап: ' + [string]$current.phase
                if ($null -ne $current.detail -and $null -ne $current.detail.bytes_total -and $current.detail.bytes_total -gt 0) {
                    $done = [Math]::Round([double]$current.detail.bytes_done / 1GB, 1)
                    $total = [Math]::Round([double]$current.detail.bytes_total / 1GB, 1)
                    $state.Text = ('Загрузка SC117: {0} / {1} ГиБ (файл {2} из {3})' -f $done, $total, $current.detail.file_index, $current.detail.files_total)
                }
            }
        } catch { # Brief partial file write: read again at next tick.
        }
    }
    if ($script:cancelRequested -and -not $script:cancelWritten -and $null -ne $script:activeRunId) {
        try {
            [IO.File]::WriteAllText($cancelFile, $script:activeRunId, (New-Object System.Text.UTF8Encoding($false)))
            $script:cancelWritten = $true
        } catch {
            $state.Text = 'Не удалось запросить отмену; повторяем...'
        }
    }
    if ($script:cancelRequested -and -not $script:finished -and $script:cancelWritten) {
        $state.Text = 'Отмена запрошена. Дождись безопасной остановки установки.'
    }
    if ($null -ne $script:child -and $script:child.HasExited -and -not $script:finished) {
        $script:finished = $true
        $timer.Stop()
        $result = $null
        try { $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json } catch { }
        $freshResult = $false
        try {
            $freshResult = $null -ne $result -and [DateTimeOffset]::Parse([string]$result.at).UtcDateTime -ge $script:shownUtc
        } catch { }
        $script:successful = $script:child.ExitCode -eq 0 -and $freshResult -and
            $result.status -eq 'passed' -and $result.runtime_state -eq 'stopped' -and $result.inference_verified -eq $true
        $script:cancelled = $script:child.ExitCode -ne 0 -and $freshResult -and $result.status -eq 'cancelled' -and $result.code -eq 'localai_user_cancelled'
        if ($script:successful) {
            $progress.Value = 100
            $state.Text = 'Готово! Модель установлена, тест генерации пройден, модель остановлена.'
            $note.Text = 'Результат: ' + $resultFile
        } elseif ($script:cancelled) {
            $state.Text = 'Локальная модель отменена по запросу. MCP продолжает работать.'
            $note.Text = 'Частично загруженные файлы сохранены. Для продолжения снова запусти Setup и выбери модель.'
        } else {
            $code = if ($null -ne $result -and $result.status -eq 'failed') { [string]$result.code } else { 'localai_setup_unknown_failure' }
            $state.Text = 'Установка остановилась: ' + $code
            $note.Text = 'Файлы сохранены для повторной попытки. Запусти тот же Setup.exe ещё раз.'
        }
        $close.Text = 'Закрыть'
        $close.Enabled = $true
    }
})
$form.Add_Shown({
    try {
        $script:shownUtc = [DateTime]::UtcNow
        $script:child = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), '--install', '--installer-approved') -WorkingDirectory $payload -WindowStyle Hidden -PassThru
        $timer.Start()
    } catch {
        $state.Text = 'Не удалось запустить установку: ' + $_.Exception.Message
        $script:finished = $true
        $close.Text = 'Закрыть'
        $close.Enabled = $true
    }
})
$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($null -ne $script:child -and -not $script:child.HasExited) {
        $eventArgs.Cancel = $true
        if (-not $script:cancelRequested) {
            [System.Windows.Forms.MessageBox]::Show('Для безопасной остановки нажми «Отменить» и дождись подтверждения.', 'KTK Qwen 125B') | Out-Null
        }
    }
})
[void]$form.ShowDialog()
if ($null -ne $script:child) { $script:child.Dispose() }
$timer.Dispose()
$form.Dispose()
if ($script:successful) { exit 0 }
if ($script:cancelled) { exit 2 }
exit 1
