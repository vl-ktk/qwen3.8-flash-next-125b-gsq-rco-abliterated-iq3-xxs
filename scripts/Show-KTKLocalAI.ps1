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
$form.Width = 720
$form.Height = 360
$form.StartPosition = 'CenterScreen'
$form.MinimizeBox = $true
$form.MaximizeBox = $false
$form.FormBorderStyle = 'FixedDialog'

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Qwen 125B — первая установка и проверка'
$title.AutoSize = $false
$title.Location = [System.Drawing.Point]::new(20, 22)
$title.Size = [System.Drawing.Size]::new(665, 33)
$title.Font = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($title)

$state = New-Object System.Windows.Forms.Label
$state.Text = 'Проверяем ПК. Для модели потребуется около 77 ГБ загрузки.'
$state.Location = [System.Drawing.Point]::new(20, 70)
$state.Size = [System.Drawing.Size]::new(665, 48)
$form.Controls.Add($state)

$hardware = New-Object System.Windows.Forms.Label
$hardware.Text = 'Оперативная память, видеокарта и свободное место: проверяем...'
$hardware.Location = [System.Drawing.Point]::new(20, 124)
$hardware.Size = [System.Drawing.Size]::new(665, 25)
$form.Controls.Add($hardware)

$download = New-Object System.Windows.Forms.Label
$download.Text = 'Загрузка: ожидание проверки ресурсов.'
$download.Location = [System.Drawing.Point]::new(20, 155)
$download.Size = [System.Drawing.Size]::new(665, 24)
$form.Controls.Add($download)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Minimum = 0
$progress.Maximum = 100
$progress.Value = 0
$progress.Location = [System.Drawing.Point]::new(20, 186)
$progress.Size = [System.Drawing.Size]::new(665, 23)
$form.Controls.Add($progress)

$note = New-Object System.Windows.Forms.Label
$note.Text = '«Пауза» сохранит загруженные части. Продолжение — здесь же, без повторной установки MCP.'
$note.Location = [System.Drawing.Point]::new(20, 220)
$note.Size = [System.Drawing.Size]::new(665, 45)
$form.Controls.Add($note)

$action = New-Object System.Windows.Forms.Button
$action.Text = 'Пауза'
$action.Enabled = $true
$action.Location = [System.Drawing.Point]::new(425, 275)
$action.Size = [System.Drawing.Size]::new(120, 32)
$action.Add_Click({
    if ($script:finished) {
        if (-not $script:successful) { Start-KTKLocalAIAttempt }
    } elseif (-not $script:cancelRequested) {
        $script:cancelRequested = $true
        $action.Enabled = $false
        $state.Text = 'Пауза запрошена. Ожидаем безопасной остановки текущего этапа...'
    }
})
$form.Controls.Add($action)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Закрыть'
$close.Enabled = $false
$close.Location = [System.Drawing.Point]::new(565, 275)
$close.Size = [System.Drawing.Size]::new(120, 32)
$close.Add_Click({ $form.Close() })
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
$phaseNames = @{
    preflight = 'Проверка Windows, RAM, VRAM и дисков'
    preflight_complete = 'Проверка ПК пройдена'
    strata_recovery = 'Восстановление прерванной установки Strata (только файлы KTK)'
    strata_ready = 'Strata готова'
    sc117_downloading = 'Загрузка модели с проверкой SHA-256'
    sc117_ready = 'Файлы модели подготовлены'
    inference_starting = 'Первый тест: загружаем модель в память'
    inference_verifying = 'Первый тест: проверяем реальный ответ модели'
    inference_stopping = 'Первый тест: останавливаем свой процесс'
    inference_verified = 'Первый тест завершён, процесс остановлен'
    complete = 'Установка и проверка завершены'
}
$errorNames = @{
    localai_ram_below_32gib = 'Недостаточно оперативной памяти (нужно минимум 32 ГиБ).'
    localai_nvidia_20gib_unverified = 'Не найдена подходящая NVIDIA с 20 ГиБ VRAM.'
    localai_fixed_disk_unverified = 'Не удалось проверить диски C: или D:.'
    sc117_disk_insufficient = 'На диске недостаточно свободного места для модели.'
    sc117_disk_insufficient_resume = 'Недостаточно свободного места для продолжения загрузки.'
    sc117_download_interrupted = 'Сеть прервала загрузку модели. Загруженные части сохранены.'
    sc117_download_hash_mismatch = 'Контрольная сумма скачанного файла не совпала.'
    sc117_runtime_start_unconfirmed_manual_attention_required = 'Статус запуска модели неизвестен. Повторять нельзя до проверки процесса.'
    sc117_runtime_stop_unconfirmed_manual_attention_required = 'Не подтверждена остановка модели! Требуется проверка процесса.'
    localai_installer_already_running_or_unavailable = 'Установка уже выполняется в другом окне.'
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 750
$timer.Add_Tick({
    if (Test-Path -LiteralPath $statusFile -PathType Leaf) {
        try {
            $current = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
            $fresh = [DateTimeOffset]::Parse([string]$current.at).UtcDateTime -ge $script:shownUtc
            if ($fresh -and $current.status -eq 'running') {
                if ($current.run_id -match '^[0-9a-f]{32}$') { $script:activeRunId = [string]$current.run_id }
                if ($null -ne $current.percent) { $progress.Value = [Math]::Max(0, [Math]::Min(100, [int]$current.percent)) }
                $phase = [string]$current.phase
                $state.Text = if ($phaseNames.ContainsKey($phase)) { $phaseNames[$phase] } else { 'Этап: ' + $phase }
                if ($phase -eq 'preflight_complete' -and $null -ne $current.detail) {
                    $diskList = @($current.detail.drives | ForEach-Object { '{0} {1} ГиБ' -f $_.drive, $_.free_gib }) -join ', '
                    $hardware.Text = ('RAM: {0} ГиБ, VRAM: {1} ГиБ; диски: {2}' -f $current.detail.ram_gib, $current.detail.vram_gib, $diskList)
                    $download.Text = ('Ожидаемая загрузка: ~{0:N1} ГБ (с учётом файлов MTP)' -f ([double]$current.detail.download_bytes / 1e9))
                }
                if ($null -ne $current.detail -and $current.detail.PSObject.Properties.Name -contains 'bytes_total' -and $current.detail.bytes_total -gt 0) {
                    $done = [Math]::Round([double]$current.detail.bytes_done / 1GB, 1)
                    $total = [Math]::Round([double]$current.detail.bytes_total / 1GB, 1)
                    $download.Text = ('Загружено: {0} / {1} ГиБ (файл {2} из {3})' -f $done, $total, $current.detail.file_index, $current.detail.files_total)
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
        $state.Text = 'Пауза запрошена. Ожидаем безопасной остановки; файлы сохраняются.'
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
            $result.status -eq 'passed' -and $result.code -eq 'localai_installed_tested' -and
            $result.runtime_state -eq 'stopped' -and $result.inference_verified -eq $true
        $script:cancelled = $script:child.ExitCode -ne 0 -and $freshResult -and $result.status -eq 'cancelled' -and $result.code -eq 'localai_user_cancelled'
        if ($script:successful) {
            $progress.Value = 100
            $state.Text = 'Готово! Модель установлена, тест генерации пройден, модель остановлена.'
            $note.Text = 'Установочные файлы остались на SSD. RAM/VRAM после теста освобождены процессом Strata; проверим это на реальном ПК.'
            $action.Enabled = $false
        } elseif ($script:cancelled) {
            $state.Text = 'Пауза завершена. MCP продолжает работать.'
            $note.Text = 'Нажми «Продолжить»: проверенные файлы не будут скачиваться заново.'
            $action.Text = 'Продолжить'
            $action.Enabled = $true
        } else {
            $code = if ($null -ne $result -and $result.status -eq 'failed') { [string]$result.code } else { 'localai_setup_unknown_failure' }
            $state.Text = if ($errorNames.ContainsKey($code)) { $errorNames[$code] } else { 'Ошибка установки: ' + $code }
            if ($code -match 'manual_attention_required|already_running') {
                $note.Text = 'Не запускай повторно до проверки процесса модели или другой установки.'
                $action.Enabled = $false
            } else {
                $note.Text = 'Файлы сохранены. Нажми «Повторить», чтобы продолжить безопасный этап.'
                $action.Text = 'Повторить'
                $action.Enabled = $true
            }
        }
        $close.Enabled = $true
    }
})
function Start-KTKLocalAIAttempt {
    if ($null -ne $script:child) {
        if (-not $script:child.HasExited) { throw 'localai_previous_attempt_still_running' }
        $script:child.Dispose()
        $script:child = $null
    }
    $script:shownUtc = [DateTime]::UtcNow
    $script:successful = $false
    $script:cancelled = $false
    $script:finished = $false
    $script:cancelRequested = $false
    $script:cancelWritten = $false
    $script:activeRunId = $null
    $state.Text = 'Запускаем подготовку модели. Проверенные файлы будут использованы повторно.'
    $hardware.Text = 'Ожидаем повторной диагностики RAM, VRAM и дисков...'
    $download.Text = 'Загрузка: проверяем сохранённые файлы.'
    $progress.Value = 0
    $action.Text = 'Пауза'
    $action.Enabled = $true
    $close.Enabled = $false
    try {
        $script:child = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), '--install', '--installer-approved') -WorkingDirectory $payload -WindowStyle Hidden -PassThru
        $timer.Start()
    } catch {
        $state.Text = 'Не удалось запустить установку: ' + $_.Exception.Message
        $script:finished = $true
        $action.Text = 'Повторить'
        $close.Enabled = $true
    }
}
$form.Add_Shown({
    Start-KTKLocalAIAttempt
})
$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($null -ne $script:child -and -not $script:child.HasExited) {
        $eventArgs.Cancel = $true
        $state.Text = 'Нажми «Пауза» и дождись безопасной остановки, затем окно можно закрыть.'
    }
})
[void]$form.ShowDialog()
if ($null -ne $script:child) { $script:child.Dispose() }
$timer.Dispose()
$form.Dispose()
if ($script:successful) { exit 0 }
if ($script:cancelled) { exit 2 }
exit 1
