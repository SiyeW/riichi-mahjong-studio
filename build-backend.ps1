[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $ProjectRoot '.conda-backend\python.exe'
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$BackendRoot = Join-Path $ReleaseRoot 'backend'
$WorkRoot = Join-Path $ReleaseRoot '.pyi-work'
$SpecRoot = Join-Path $ReleaseRoot '.pyi-spec'

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw 'Missing .conda-backend environment. Create it from environment.yml first.'
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
    --name environment-service `
    --distpath $BackendRoot `
    --workpath $WorkRoot `
    --specpath $SpecRoot `
    --paths (Join-Path $ProjectRoot 'python\environment') `
    --paths (Join-Path $ProjectRoot 'python\vendor') `
    --hidden-import engine_process_client `
    --hidden-import rule_kernel `
    --hidden-import mahjong `
    --hidden-import mahjong.hand_calculating.hand `
    --hidden-import mahjong.meld `
    --exclude-module onnxruntime `
    --exclude-module torch `
    --exclude-module tensorflow `
    --exclude-module pytest `
    (Join-Path $ProjectRoot 'python\environment\service_bootstrap.py')

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code $LASTEXITCODE."
}

$Executable = Join-Path $BackendRoot 'environment-service\environment-service.exe'
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "Backend build did not produce the expected executable: $Executable"
}

Write-Host "Built backend service: $Executable"
Write-Host 'No engine runtime, model weight, or sound asset was included.'
