[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvironmentRoot = Join-Path $ProjectRoot '.conda-backend'
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$TargetRoot = Join-Path $ReleaseRoot 'third-party-licenses'

function Assert-ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $ResolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
    $ResolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $ResolvedPath.StartsWith($ResolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the project: $ResolvedPath"
    }
}

function Copy-LicenseFiles {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$DestinationDirectory
    )

    $LicenseFiles = Get-ChildItem -LiteralPath $SourceDirectory -File |
        Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE)(\..*)?$' }
    if (-not $LicenseFiles) {
        throw "No license file found in $SourceDirectory"
    }

    New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
    foreach ($LicenseFile in $LicenseFiles) {
        Copy-Item -LiteralPath $LicenseFile.FullName -Destination $DestinationDirectory
    }
}

Assert-ProjectPath $TargetRoot
if (Test-Path -LiteralPath $TargetRoot) {
    Remove-Item -LiteralPath $TargetRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $TargetRoot | Out-Null

$NpmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$NpmOutput = & $NpmCommand ls --omit=dev --all --json --long
if ($LASTEXITCODE -ne 0) {
    throw "npm ls failed with exit code $LASTEXITCODE."
}
$NpmTree = $NpmOutput | ConvertFrom-Json
$NpmPackages = [System.Collections.Generic.List[object]]::new()
$SeenNpmPackages = @{}

function Visit-NpmPackage {
    param([Parameter(Mandatory = $true)][object]$Package)

    if ($Package.path -and $Package.path -ne $ProjectRoot) {
        $Key = "$($Package.name)@$($Package.version)"
        if (-not $SeenNpmPackages.ContainsKey($Key)) {
            $SeenNpmPackages[$Key] = $true
            $SafeName = ($Key -replace '[^A-Za-z0-9._-]', '_')
            $Destination = Join-Path $TargetRoot (Join-Path 'renderer' $SafeName)
            Copy-LicenseFiles -SourceDirectory $Package.path -DestinationDirectory $Destination
            $NpmPackages.Add([pscustomobject]@{
                Name = $Package.name
                Version = $Package.version
                License = $Package.license
            })
        }
    }

    if ($Package.dependencies) {
        foreach ($Dependency in $Package.dependencies.PSObject.Properties) {
            Visit-NpmPackage -Package $Dependency.Value
        }
    }
}

Visit-NpmPackage -Package $NpmTree

if (-not (Test-Path -LiteralPath $EnvironmentRoot -PathType Container)) {
    throw 'Missing .conda-backend environment. Create it from environment.yml first.'
}

$CondaCommand = (Get-Command conda.exe -ErrorAction Stop).Source
$CondaOutput = & $CondaCommand info --json
if ($LASTEXITCODE -ne 0) {
    throw "conda info failed with exit code $LASTEXITCODE."
}
$CondaInfo = $CondaOutput | ConvertFrom-Json
$NativePackageNames = @(
    'python',
    'openssl',
    'libffi',
    'bzip2',
    'libexpat',
    'liblzma',
    'libzlib',
    'ucrt',
    'vc14_runtime',
    'vcomp14'
)
$NativePackages = [System.Collections.Generic.List[object]]::new()

foreach ($PackageName in $NativePackageNames) {
    $MetadataPath = Get-ChildItem -LiteralPath (Join-Path $EnvironmentRoot 'conda-meta') `
        -Filter "$PackageName-*.json" -File | Select-Object -First 1
    if (-not $MetadataPath) {
        throw "Missing Conda metadata for $PackageName."
    }

    $Metadata = Get-Content -Raw -LiteralPath $MetadataPath.FullName | ConvertFrom-Json
    $CacheDirectoryName = $Metadata.fn -replace '\.(conda|tar\.bz2)$', ''
    $CacheDirectory = $CondaInfo.pkgs_dirs |
        ForEach-Object { Join-Path $_ $CacheDirectoryName } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        Select-Object -First 1
    if (-not $CacheDirectory) {
        throw "Cannot find the Conda package cache for $($Metadata.fn)."
    }

    $SourceLicenses = Join-Path $CacheDirectory 'info\licenses'
    if (-not (Test-Path -LiteralPath $SourceLicenses -PathType Container)) {
        throw "No license directory found for Conda package $PackageName."
    }

    $Destination = Join-Path $TargetRoot (Join-Path 'backend' "$PackageName-$($Metadata.version)")
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -Path (Join-Path $SourceLicenses '*') -Destination $Destination -Recurse
    $NativePackages.Add([pscustomobject]@{
        Name = $PackageName
        Version = $Metadata.version
        License = $Metadata.license
    })
}

$NumpyMetadata = Get-ChildItem -LiteralPath (Join-Path $EnvironmentRoot 'Lib\site-packages') `
    -Directory -Filter 'numpy-*.dist-info' | Select-Object -First 1
if (-not $NumpyMetadata) {
    throw 'Cannot find NumPy package metadata.'
}
$NumpyPackage = Get-Content -Raw -LiteralPath (Join-Path $NumpyMetadata.FullName 'METADATA')
$NumpyVersion = ([regex]::Match($NumpyPackage, '(?m)^Version:\s*(.+)$')).Groups[1].Value.Trim()
$NumpyLicenses = Join-Path $NumpyMetadata.FullName 'licenses'
$NumpyDestination = Join-Path $TargetRoot (Join-Path 'backend' "numpy-$NumpyVersion")
New-Item -ItemType Directory -Path $NumpyDestination -Force | Out-Null
Copy-Item -Path (Join-Path $NumpyLicenses '*') -Destination $NumpyDestination -Recurse

$PyInstallerMetadata = Get-ChildItem -LiteralPath (Join-Path $EnvironmentRoot 'Lib\site-packages') `
    -Directory -Filter 'pyinstaller-*.dist-info' | Select-Object -First 1
if (-not $PyInstallerMetadata) {
    throw 'Cannot find PyInstaller package metadata.'
}
$PyInstallerPackage = Get-Content -Raw -LiteralPath (Join-Path $PyInstallerMetadata.FullName 'METADATA')
$PyInstallerVersion = ([regex]::Match($PyInstallerPackage, '(?m)^Version:\s*(.+)$')).Groups[1].Value.Trim()
$PyInstallerDestination = Join-Path $TargetRoot (Join-Path 'backend' "pyinstaller-$PyInstallerVersion")
New-Item -ItemType Directory -Path $PyInstallerDestination -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PyInstallerMetadata.FullName 'licenses\COPYING.txt') `
    -Destination $PyInstallerDestination

$ElectronPackage = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'node_modules\electron\package.json') |
    ConvertFrom-Json
$Readme = [System.Collections.Generic.List[string]]::new()
$Readme.Add('# Third-party licenses')
$Readme.Add('')
$Readme.Add('This directory is generated from the locked release environments.')
$Readme.Add('It accompanies, but does not replace, `THIRD_PARTY_NOTICES.md`.')
$Readme.Add('')
$Readme.Add('## Electron and Chromium')
$Readme.Add('')
$Readme.Add("Electron $($ElectronPackage.version) is distributed under the MIT license. Its")
$Readme.Add('`LICENSE.electron.txt` and Chromium notice collection')
$Readme.Add('`LICENSES.chromium.html` are included in the application directory by Electron.')
$Readme.Add('')
$Readme.Add('## Renderer packages')
$Readme.Add('')
$Readme.Add('| Package | Version | Declared license |')
$Readme.Add('| --- | --- | --- |')
foreach ($Package in ($NpmPackages | Sort-Object Name, Version)) {
    $Readme.Add("| $($Package.Name) | $($Package.Version) | $($Package.License) |")
}
$Readme.Add('')
$Readme.Add('## Backend runtime')
$Readme.Add('')
$Readme.Add('| Package | Version | Declared license |')
$Readme.Add('| --- | --- | --- |')
foreach ($Package in ($NativePackages | Sort-Object Name)) {
    $Readme.Add("| $($Package.Name) | $($Package.Version) | $($Package.License) |")
}
$Readme.Add("| numpy | $NumpyVersion | See included license collection |")
$Readme.Add("| PyInstaller bootloader | $PyInstallerVersion | GPL-2.0-or-later with Bootloader Exception |")
$Readme.Add('')
$Readme.Add('The corresponding license texts are stored below this directory.')
Set-Content -LiteralPath (Join-Path $TargetRoot 'README.md') -Value $Readme -Encoding utf8

Write-Host "Collected third-party licenses: $TargetRoot"
