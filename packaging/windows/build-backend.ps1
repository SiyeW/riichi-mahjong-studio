[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Python = Join-Path $ProjectRoot '.conda-backend\python.exe'
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$BackendRoot = Join-Path $ReleaseRoot 'backend'
$WorkRoot = Join-Path $ReleaseRoot '.pyi-work'
$SpecRoot = Join-Path $ReleaseRoot '.pyi-spec'
$SqliteLibrary = Join-Path $ProjectRoot '.conda-backend\Library\bin\sqlite3.dll'

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw 'Missing .conda-backend environment. Run packaging\windows\setup-environment.ps1 first.'
}
if (-not (Test-Path -LiteralPath $SqliteLibrary -PathType Leaf)) {
    throw 'Missing the locked SQLite runtime. Recreate the backend environment before packaging.'
}
& $Python -c "import sqlite3; assert sqlite3.sqlite_version_info >= (3, 51, 3), sqlite3.sqlite_version"
if ($LASTEXITCODE -ne 0) {
    throw 'Backend recovery requires SQLite 3.51.3 or newer.'
}

function Assert-ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $ResolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
    $ResolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $ResolvedPath.StartsWith($ResolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the project: $ResolvedPath"
    }
}

foreach ($Path in @($BackendRoot, $WorkRoot, $SpecRoot)) {
    Assert-ProjectPath $Path
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

& $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --noupx `
    --onedir `
    --name rms-backend `
    --distpath $BackendRoot `
    --workpath $WorkRoot `
    --specpath $SpecRoot `
    --paths (Join-Path $ProjectRoot 'python') `
    --paths (Join-Path $ProjectRoot 'python\vendor') `
    --add-binary "$SqliteLibrary;." `
    --hidden-import rms_backend.record_workspace `
    --hidden-import rms_backend.engine_process_client `
    --hidden-import rms_backend.rule_kernel `
    --hidden-import mahjong `
    --hidden-import mahjong.hand_calculating.hand `
    --hidden-import mahjong.meld `
    --exclude-module onnxruntime `
    --exclude-module torch `
    --exclude-module tensorflow `
    --exclude-module pytest `
    (Join-Path $ProjectRoot 'python\rms_backend\__main__.py')

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code $LASTEXITCODE."
}

$Executable = Join-Path $BackendRoot 'rms-backend\rms-backend.exe'
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "Backend build did not produce the expected executable: $Executable"
}

Write-Host "Built backend service: $Executable"
Write-Host 'No engine runtime, model weight, or sound asset was included.'
