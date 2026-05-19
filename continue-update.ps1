# continue-update.ps1 — Продолжить после решения конфликтов
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = "G:\FORK\opencode"
Set-Location $root

# Проверяем что мы в процессе rebase
$rebaseDir = Test-Path "$root\.git\rebase-merge"
$rebaseApply = Test-Path "$root\.git\rebase-apply"
if (-not $rebaseDir -and -not $rebaseApply) {
    Write-Host "Rebase не в процессе. Всё уже готово?" -ForegroundColor Yellow
    exit 0
}

# Проверяем есть ли ещё конфликты
$conflicts = git diff --name-only --diff-filter=U
if ($conflicts) {
    Write-Host "Ещё есть конфликты:" -ForegroundColor Red
    Write-Host $conflicts
    Write-Host ""
    Write-Host "Реши их, потом: git add . && запусти этот скрипт снова" -ForegroundColor Yellow
    exit 1
}

Write-Host "=== Продолжаю rebase ===" -ForegroundColor Cyan
git rebase --continue
if ($LASTEXITCODE -ne 0) {
    Write-Host "Ещё конфликты. Реши и запусти снова." -ForegroundColor Yellow
    exit 1
}

Write-Host "=== Пушу fork ===" -ForegroundColor Cyan
git push origin fork --force-with-lease --no-verify
if ($LASTEXITCODE -ne 0) {
    Write-Host "ОШИБКА push. Попробуй: git push origin fork --force-with-lease --no-verify" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Обновление завершено! ===" -ForegroundColor Green
Write-Host "Теперь запусти: .\build-fork.ps1" -ForegroundColor Cyan

Remove-Item "$root\continue-update.ps1" -ErrorAction SilentlyContinue
