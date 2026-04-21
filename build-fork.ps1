# build-fork.ps1 — Full fork build pipeline (opencode)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$root = "G:\FORK\opencode"

Set-Location $root

Write-Host "=== Step 1: Install dependencies ===" -ForegroundColor Cyan
bun install
if ($LASTEXITCODE -ne 0) { throw "bun install failed" }

Write-Host "=== Step 2: Build ===" -ForegroundColor Cyan
bun run --cwd packages/opencode build -- --single
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green

Set-Location $root
