[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$EnvironmentRoot = Join-Path $ProjectRoot '.conda-backend'
$PackagingRoot = $PSScriptRoot
$EnvironmentFile = Join-Path $PackagingRoot 'environment.yml'
$RequirementsFile = Join-Path $PackagingRoot 'requirements-release.txt'
$ProjectCondarc = Join-Path $PackagingRoot '.condarc'
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

    $Python = Join-Path $EnvironmentRoot 'python.exe'
    & $Python -m pip install -r $RequirementsFile
    if ($LASTEXITCODE -ne 0) {
        throw "Pip failed with exit code $LASTEXITCODE."
    }
} finally {
    if ($null -eq $PreviousCondarc) {
        Remove-Item Env:CONDARC -ErrorAction SilentlyContinue
    } else {
        $env:CONDARC = $PreviousCondarc
    }
}

Write-Host "Backend environment is ready: $EnvironmentRoot"
