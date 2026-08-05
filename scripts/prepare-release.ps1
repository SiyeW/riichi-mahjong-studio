[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Package = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$Version = $Package.version
$ProductSlug = 'Riichi-Mahjong-Studio'
$UnpackedRoot = Join-Path $ProjectRoot 'release\electron\win-unpacked'
$ArtifactsRoot = Join-Path $ProjectRoot 'release\artifacts'
$BundleName = "$ProductSlug-$Version-windows-x64"
$BundleRoot = Join-Path $ArtifactsRoot $BundleName
$ArchivePath = Join-Path $ArtifactsRoot "$BundleName.zip"
$ChecksumPath = Join-Path $ArtifactsRoot 'SHA256SUMS.txt'
$ReleaseNotesPath = Join-Path $ArtifactsRoot 'RELEASE_NOTES.md'

function Assert-ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $ResolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
    $ResolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $ResolvedPath.StartsWith($ResolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the project: $ResolvedPath"
    }
}

if (-not (Test-Path -LiteralPath $UnpackedRoot -PathType Container)) {
    throw "Missing unpacked Windows application: $UnpackedRoot"
}

Assert-ProjectPath $ArtifactsRoot
if (Test-Path -LiteralPath $ArtifactsRoot) {
    Remove-Item -LiteralPath $ArtifactsRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $BundleRoot -Force | Out-Null
Copy-Item -Path (Join-Path $UnpackedRoot '*') -Destination $BundleRoot -Recurse

Compress-Archive -LiteralPath $BundleRoot -DestinationPath $ArchivePath -CompressionLevel Optimal
$Sha256 = [System.Security.Cryptography.SHA256]::Create()
$ArchiveStream = [System.IO.File]::OpenRead($ArchivePath)
try {
    $ChecksumBytes = $Sha256.ComputeHash($ArchiveStream)
} finally {
    $ArchiveStream.Dispose()
    $Sha256.Dispose()
}
$Checksum = ([System.BitConverter]::ToString($ChecksumBytes) -replace '-', '').ToLowerInvariant()
Set-Content -LiteralPath $ChecksumPath -Value "$Checksum  $([System.IO.Path]::GetFileName($ArchivePath))" `
    -Encoding ascii

$Changelog = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'CHANGELOG.md')
$EscapedVersion = [regex]::Escape($Version)
$Match = [regex]::Match(
    $Changelog,
    "(?ms)^## \[$EscapedVersion\][^\r\n]*\r?\n(?<body>.*?)(?=^## \[|\z)"
)
if (-not $Match.Success) {
    throw "CHANGELOG.md has no section for version $Version."
}

$ReleaseNotes = @(
    "# Riichi Mahjong Studio $Version"
    ''
    'Windows x64 portable preview build. This build is not code-signed.'
    ''
    $Match.Groups['body'].Value.Trim()
)
Set-Content -LiteralPath $ReleaseNotesPath -Value $ReleaseNotes -Encoding utf8

Write-Host "Prepared release archive: $ArchivePath"
Write-Host "SHA-256: $Checksum"
Write-Host "Release notes: $ReleaseNotesPath"
