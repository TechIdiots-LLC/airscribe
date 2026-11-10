# Uploads the files in release-files/ and a SHA256SUMS of them to the generic package registry and creates the GitLab
# release, with the matching CHANGELOG.md section and download notes as its description. Files are attached with
# permanent links: <project>/-/releases/<tag>/downloads/<file>, which is where Admin -> Updates' updater
# (deploy/linux/airscribe-update) downloads them from. Based on garage-lxc's and MediaRiffle's.
param(
    [string]$PackageName = 'airscribe',
    [string]$ReleaseName = 'AirScribe',
    [string]$FilesDir = 'release-files'
)

$ErrorActionPreference = 'Stop'

if ($env:RELEASE_PUBLISH -ne 'true') {
    Write-Host "Not publishing $env:RELEASE_TAG (dry run, or already released)."
    exit 0
}

$version = $env:RELEASE_VERSION
$tag = $env:RELEASE_TAG
$api = "$env:CI_API_V4_URL/projects/$env:CI_PROJECT_ID"
$jobHeaders = @{ 'JOB-TOKEN' = $env:CI_JOB_TOKEN }

$files = @(Get-ChildItem $FilesDir -File -ErrorAction SilentlyContinue | Where-Object Name -ne 'SHA256SUMS')
if (-not $files) { throw "No release files found in $FilesDir" }
$deb = ($files | Where-Object Name -like 'airscribe_*_all.deb' | Select-Object -First 1).Name
$template = ($files | Where-Object Name -like '*-proxmox-amd64.tar.zst' | Select-Object -First 1).Name
if (-not $deb -or -not $template) { throw "Expected the .deb and the Proxmox template in $FilesDir" }

# SHA256SUMS, as sha256sum writes it: Admin -> Updates' updater checks what it downloads against it
$sums = $files | Sort-Object Name | ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)" }
$sumsFile = Join-Path (Convert-Path $FilesDir) 'SHA256SUMS'
[IO.File]::WriteAllText($sumsFile, (($sums -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
$files = @(Get-ChildItem $FilesDir -File)
if ($files.Name -notcontains 'SHA256SUMS') { throw "SHA256SUMS wasn't written to $FilesDir ($sumsFile): a release without it can't be updated to from Admin -> Updates" }

# Release notes: the lines under "## <version>" up to the next "## " heading
$notes = @()
$inSection = $false
foreach ($line in Get-Content CHANGELOG.md -Encoding UTF8) {
    if ($line -eq "## $version") { $inSection = $true; continue }
    if ($inSection -and $line -match '^## ') { break }
    if ($inSection) { $notes += $line }
}
$notes += @(
    ''
    '## Downloads'
    ''
    "- **Proxmox:** ``$template`` is an LXC template with AirScribe installed (docs/proxmox.md)."
    "- **Ubuntu 24.04 / Debian 12:** ``$deb``, with Node 22.13 or newer from NodeSource (docs/installing.md)."
    '- **Updating:** an install from either updates itself from Admin -> Updates (docs/updating.md); `SHA256SUMS`'
    '  is what it checks the download against.'
)
$description = ($notes -join "`n").Trim()
Write-Host "--- Release notes ---`n$description"

$links = @()
foreach ($file in $files) {
    $url = "$api/packages/generic/$PackageName/$version/$([uri]::EscapeDataString($file.Name))"
    Write-Host "Uploading $($file.Name)"
    Invoke-RestMethod -Method Put -Uri $url -Headers $jobHeaders -InFile $file.FullName | Out-Null
    $links += @{ name = $file.Name; url = $url; direct_asset_path = "/$($file.Name)"; link_type = 'package' }
}

$release = @{
    name        = if ($env:RELEASE_PRERELEASE -eq 'true') { "$ReleaseName $tag (pre-release)" } else { "$ReleaseName $tag" }
    tag_name    = $tag
    ref         = $env:CI_COMMIT_SHA
    description = $description
    assets      = @{ links = $links }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $jobHeaders -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($release)) | Out-Null
Write-Host "Created release ${tag}: $env:CI_PROJECT_URL/-/releases/$([uri]::EscapeDataString($tag))"
