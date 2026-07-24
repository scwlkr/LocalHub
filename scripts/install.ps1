#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PinnedBun = "bun@1.3.14"
$UsingDefaultInstallDir = [string]::IsNullOrWhiteSpace($InstallDir)
$LocationPushed = $false

function Invoke-BunX {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    & $script:BunXPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function ConvertTo-NormalizedPath {
    param(
        [AllowNull()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $Candidate = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
    try {
        $Candidate = [IO.Path]::GetFullPath($Candidate)
    }
    catch {
        # Keep an unusual existing PATH entry intact for comparison.
    }

    return $Candidate.TrimEnd([char[]]@('\', '/'))
}

function Test-PathListContains {
    param(
        [AllowNull()]
        [string]$PathList,

        [Parameter(Mandatory = $true)]
        [string]$Directory
    )

    $NormalizedDirectory = ConvertTo-NormalizedPath $Directory
    if ([string]::IsNullOrEmpty($PathList)) {
        return $false
    }

    foreach ($Entry in $PathList.Split([IO.Path]::PathSeparator)) {
        $NormalizedEntry = ConvertTo-NormalizedPath $Entry
        if (
            $null -ne $NormalizedEntry -and
            [StringComparer]::OrdinalIgnoreCase.Equals($NormalizedEntry, $NormalizedDirectory)
        ) {
            return $true
        }
    }

    return $false
}

function Add-DefaultInstallDirToPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory
    )

    $UserPath = [Environment]::GetEnvironmentVariable(
        "Path",
        [EnvironmentVariableTarget]::User
    )
    $Changed = $false

    if (-not (Test-PathListContains $UserPath $Directory)) {
        $Separator = [IO.Path]::PathSeparator
        $NewUserPath = if ([string]::IsNullOrEmpty($UserPath)) {
            $Directory
        }
        elseif ($UserPath.EndsWith([string]$Separator)) {
            "$UserPath$Directory"
        }
        else {
            "$UserPath$Separator$Directory"
        }

        [Environment]::SetEnvironmentVariable(
            "Path",
            $NewUserPath,
            [EnvironmentVariableTarget]::User
        )
        $Changed = $true
    }

    if (-not (Test-PathListContains $env:Path $Directory)) {
        $env:Path = if ([string]::IsNullOrEmpty($env:Path)) {
            $Directory
        }
        else {
            "$($env:Path)$([IO.Path]::PathSeparator)$Directory"
        }
    }

    return $Changed
}

function Install-Executable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,

        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $DestinationDirectory = [IO.Path]::GetDirectoryName($Destination)
    [IO.Directory]::CreateDirectory($DestinationDirectory) | Out-Null

    $Nonce = [Guid]::NewGuid().ToString("N")
    $Staged = Join-Path $DestinationDirectory ".lh-$Nonce.exe"
    $Backup = Join-Path $DestinationDirectory ".lh-$Nonce.bak"

    try {
        [IO.File]::Copy($Source, $Staged, $false)

        if ([IO.File]::Exists($Destination)) {
            [IO.File]::Replace($Staged, $Destination, $Backup, $true)
        }
        else {
            [IO.File]::Move($Staged, $Destination)
        }
    }
    catch {
        $InstallError = $_.Exception.Message
        if (-not [IO.File]::Exists($Destination) -and [IO.File]::Exists($Backup)) {
            try {
                [IO.File]::Move($Backup, $Destination)
            }
            catch {
                throw "Install failed and the previous lh.exe remains at '$Backup'."
            }
        }

        throw "Could not replace '$Destination'. Close any running lh.exe and retry. $InstallError"
    }
    finally {
        if ([IO.File]::Exists($Staged)) {
            [IO.File]::Delete($Staged)
        }
    }

    if ([IO.File]::Exists($Backup)) {
        [IO.File]::Delete($Backup)
    }
}

try {
    if ([Environment]::GetEnvironmentVariable("OS") -ne "Windows_NT") {
        throw "This installer requires Windows x64."
    }

    $Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($Architecture -ne [Runtime.InteropServices.Architecture]::X64) {
        throw "This installer requires Windows x64; found $Architecture."
    }

    $Bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $Bun) {
        throw "Bun is required. Install Bun, open a new PowerShell window, and retry."
    }

    $BunX = Get-Command bunx -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $BunX) {
        throw "bunx is required. Reinstall Bun, open a new PowerShell window, and retry."
    }
    $script:BunXPath = $BunX.Path

    if ($UsingDefaultInstallDir) {
        $LocalAppData = [Environment]::GetFolderPath(
            [Environment+SpecialFolder]::LocalApplicationData
        )
        if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
            throw "Windows did not provide a per-user Local AppData directory."
        }
        $InstallDir = Join-Path $LocalAppData "Programs\LocalHub"
    }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $InstallRoot = [IO.Path]::GetPathRoot($InstallDir)
    if ([StringComparer]::OrdinalIgnoreCase.Equals($InstallDir, $InstallRoot)) {
        throw "Refusing to install directly into '$InstallRoot'."
    }

    $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    Push-Location $RepoRoot
    $LocationPushed = $true

    Write-Host "Building LocalHub for Windows x64..."
    Invoke-BunX `
        -Arguments @("--silent", $PinnedBun, "install", "--frozen-lockfile", "--silent") `
        -FailureMessage "Frozen dependency install failed."
    Invoke-BunX `
        -Arguments @("--silent", $PinnedBun, "run", "build") `
        -FailureMessage "Windows standalone build failed."

    $BuiltExecutable = Join-Path $RepoRoot "dist\lh.exe"
    if (-not [IO.File]::Exists($BuiltExecutable)) {
        throw "Build completed without dist\lh.exe."
    }

    $InstalledExecutable = Join-Path $InstallDir "lh.exe"
    Install-Executable -Source $BuiltExecutable -Destination $InstalledExecutable

    & $InstalledExecutable --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Installed lh.exe failed its version smoke test."
    }
    & $InstalledExecutable --help | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Installed lh.exe failed its help smoke test."
    }

    if ($UsingDefaultInstallDir) {
        $PathChanged = Add-DefaultInstallDirToPath $InstallDir
        if ($PathChanged) {
            Write-Host "Added $InstallDir to your user PATH."
        }
    }

    Write-Host "Installed $InstalledExecutable"
    if ($UsingDefaultInstallDir) {
        Write-Host "Run: lh --help"
        Write-Host "If lh is not found, open a new terminal."
    }
    else {
        Write-Host "Run: & `"$InstalledExecutable`" --help"
    }
}
catch {
    [Console]::Error.WriteLine("LocalHub install failed: $($_.Exception.Message)")
    exit 1
}
finally {
    if ($LocationPushed) {
        Pop-Location
    }
}
