# update-fork.ps1 — Update fork from upstream tag
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$root = "G:\FORK\opencode"

Set-Location $root

# ============================================
# ПРОВЕРКИ
# ============================================

Write-Host ""
Write-Host "=== Проверяю состояние ===" -ForegroundColor Cyan

# Проверяем незакоммиченные изменения
$status = git status --porcelain
if ($status) {
    Write-Host "ОШИБКА: Есть незакоммиченные изменения!" -ForegroundColor Red
    Write-Host $status
    Write-Host ""
    Write-Host "Сначала закоммить или спрячь:" -ForegroundColor Yellow
    Write-Host "  git add . && git commit -m 'wip: save'" -ForegroundColor Yellow
    Write-Host "  или: git stash" -ForegroundColor Yellow
    exit 1
}

$currentBranch = git branch --show-current
Write-Host "Текущая ветка: $currentBranch" -ForegroundColor Gray

# ============================================
# ПОЛУЧАЕМ ТЕГИ
# ============================================

Write-Host ""
Write-Host "=== Скачиваю обновления ===" -ForegroundColor Cyan
git fetch upstream --tags
if ($LASTEXITCODE -ne 0) {
    Write-Host "ОШИБКА: upstream недоступен" -ForegroundColor Red
    Write-Host "Проверь: git remote -v" -ForegroundColor Yellow
    exit 1
}

# Показываем последние теги
Write-Host ""
Write-Host "=== Доступные теги ===" -ForegroundColor Cyan
git tag -l "v1.*" | Where-Object { $_ -notmatch 'rc|alpha|beta|dev' } | Sort-Object { [version]($_ -replace '^v','') } | Select-Object -Last 10

# Текущий тег на dev
$currentTag = git describe --tags --abbrev=0 dev 2>$null
Write-Host ""
Write-Host "Текущая версия dev: $currentTag" -ForegroundColor Gray

# Спрашиваем какой тег
Write-Host ""
$newTag = Read-Host "Введи тег для обновления (например v1.14.19) или Enter для отмены"
if (-not $newTag) {
    Write-Host "Отменено." -ForegroundColor Yellow
    exit 0
}

# Проверяем что тег существует
$tagExists = git tag -l $newTag
if (-not $tagExists) {
    Write-Host "ОШИБКА: Тег $newTag не найден!" -ForegroundColor Red
    exit 1
}

if ($newTag -eq $currentTag) {
    Write-Host "Уже на $newTag, обновление не нужно." -ForegroundColor Yellow
    exit 0
}

# ============================================
# ОБНОВЛЯЕМ DEV
# ============================================

Write-Host ""
Write-Host "=== Обновляю dev до $newTag ===" -ForegroundColor Cyan
git checkout dev
if ($LASTEXITCODE -ne 0) { throw "Не могу переключиться на dev" }

git reset --hard $newTag
if ($LASTEXITCODE -ne 0) { throw "Не могу сбросить dev до $newTag" }

Write-Host "Пушу dev..." -ForegroundColor Gray
git push origin dev --force-with-lease --no-verify
if ($LASTEXITCODE -ne 0) {
    Write-Host "ОШИБКА: Не могу запушить dev" -ForegroundColor Red
    Write-Host "Попробуй вручную: git push origin dev --force-with-lease --no-verify" -ForegroundColor Yellow
    exit 1
}
Write-Host "dev обновлён до $newTag" -ForegroundColor Green

# ============================================
# ПЕРЕБАЗИРУЕМ FORK
# ============================================

Write-Host ""
Write-Host "=== Перебазирую fork на $newTag ===" -ForegroundColor Cyan
git checkout fork
if ($LASTEXITCODE -ne 0) { throw "Не могу переключиться на fork" }

git rebase dev
$rebaseResult = $LASTEXITCODE

if ($rebaseResult -ne 0) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "  КОНФЛИКТ! Нужно решить вручную." -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Конфликтные файлы:" -ForegroundColor Red
    git diff --name-only --diff-filter=U
    Write-Host ""
    Write-Host "Что делать:" -ForegroundColor Cyan
    Write-Host "  1. Открой файлы и реши конфликты (ищи <<<<<<)" -ForegroundColor White
    Write-Host "  2. git add ." -ForegroundColor White
    Write-Host "  3. git rebase --continue" -ForegroundColor White
    Write-Host "  4. Запусти: .\continue-update.ps1" -ForegroundColor White
    Write-Host ""
    Write-Host "Или отмени: git rebase --abort" -ForegroundColor Yellow
    Write-Host ""

    # Создаём скрипт для продолжения
    @'
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
'@ | Set-Content "$root\continue-update.ps1" -Encoding UTF8

    exit 1
}

# ============================================
# ПУШИМ
# ============================================

Write-Host ""
Write-Host "=== Пушу fork ===" -ForegroundColor Cyan
git push origin fork --force-with-lease --no-verify
if ($LASTEXITCODE -ne 0) {
    Write-Host "ОШИБКА push" -ForegroundColor Red
    exit 1
}

# ============================================
# ГОТОВО
# ============================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Обновление завершено!" -ForegroundColor Green
Write-Host "  dev: $newTag" -ForegroundColor Green
Write-Host "  fork: $newTag + твои патчи" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Теперь запусти: .\build-fork.ps1" -ForegroundColor Cyan

# Удаляем continue-update если остался от прошлого раза
Remove-Item "$root\continue-update.ps1" -ErrorAction SilentlyContinue
