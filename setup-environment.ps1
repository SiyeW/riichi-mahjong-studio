[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvironmentRoot = Join-Path $ProjectRoot '.conda-backend'
$EnvironmentFile = Join-Path $ProjectRoot 'environment.yml'
$ProjectCondarc = Join-Path $ProjectRoot '.condarc'
$PreviousCondarc = [System.Environment]::GetEnvironmentVariable('CONDARC', 'Process')

try {
    $env:CONDARC = $ProjectCondarc
    if (Test-Path -LiteralPath (Join-Path $EnvironmentRoot 'conda-meta') -PathType Container) {
        & conda env update --prefix $EnvironmentRoot --file $EnvironmentFile --prune
    } else {
        & conda env create --prefix $EnvironmentRoot --file $EnvironmentFile
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Conda failed with exit code $LASTEXITCODE."
    }
} finally {
    if ($null -eq $PreviousCondarc) {
        Remove-Item Env:CONDARC -ErrorAction SilentlyContinue
    } else {
        $env:CONDARC = $PreviousCondarc
    }
}

Write-Host "Backend environment is ready: $EnvironmentRoot"
