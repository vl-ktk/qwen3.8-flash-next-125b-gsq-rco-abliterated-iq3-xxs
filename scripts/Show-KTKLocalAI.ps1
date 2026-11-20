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
$note.Text = 'Не выключай компьютер во время установки. После сбоя можно запустить этот же Setup ещё раз.'
$note.Location = [System.Drawing.Point]::new(20, 163)
$note.Size = [System.Drawing.Size]::new(610, 31)
$form.Controls.Add($note)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Ожидание...'
$close.Enabled = $false
$close.Location = [System.Drawing.Point]::new(510, 204)
$close.Size = [System.Drawing.Size]::new(120, 31)
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

$statusFile = Join-Path $env:LOCALAPPDATA 'KTK\LocalAI\status.json'
$resultFile = Join-Path $env:LOCALAPPDATA 'KTK\LocalAI\result.json'
$script:child = $null
$script:successful = $false
$script:finished = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 750
$timer.Add_Tick({
    if (Test-Path -LiteralPath $statusFile -PathType Leaf) {
        try {
            $current = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
            if ($current.status -eq 'running') {
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
    if ($null -ne $script:child -and $script:child.HasExited -and -not $script:finished) {
        $script:finished = $true
        $timer.Stop()
        $result = $null
        try { $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json } catch { }
        $script:successful = $script:child.ExitCode -eq 0 -and $null -ne $result -and $result.status -eq 'passed'
        if ($script:successful) {
            $progress.Value = 100
            $state.Text = 'Готово! Strata, модель и тест генерации прошли проверку.'
            $note.Text = 'Результат: ' + $resultFile
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
        [System.Windows.Forms.MessageBox]::Show('Установка ещё работает. Дождись завершения, чтобы не повредить частично загруженные файлы.', 'KTK Qwen 125B') | Out-Null
    }
})
[void]$form.ShowDialog()
if ($null -ne $script:child) { $script:child.Dispose() }
$timer.Dispose()
$form.Dispose()
if ($script:successful) { exit 0 }
exit 1
