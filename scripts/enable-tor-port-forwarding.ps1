param(
    [int[]]$Ports = @(9050, 8118, 9051),
    [string]$ListenAddress = "0.0.0.0",
    [string]$ConnectAddress = "127.0.0.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "Run this script from an elevated PowerShell window (Run as Administrator)."
}

Set-Service -Name iphlpsvc -StartupType Automatic
if ((Get-Service -Name iphlpsvc).Status -ne "Running") {
    Start-Service -Name iphlpsvc
}

foreach ($p in $Ports) {
    $inName = "WECRYPTO Tor Inbound TCP $p"
    $outName = "WECRYPTO Tor Outbound TCP $p"

    if (-not (Get-NetFirewallRule -DisplayName $inName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $inName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -Profile Any | Out-Null
    }
    if (-not (Get-NetFirewallRule -DisplayName $outName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $outName -Direction Outbound -Action Allow -Protocol TCP -RemotePort $p -Profile Any | Out-Null
    }

    & netsh interface portproxy delete v4tov4 listenaddress=$ListenAddress listenport=$p | Out-Null
    & netsh interface portproxy add v4tov4 listenaddress=$ListenAddress listenport=$p connectaddress=$ConnectAddress connectport=$p | Out-Null
    Write-Host "Forwarding enabled: $ListenAddress`:$p -> $ConnectAddress`:$p" -ForegroundColor Green
}

Write-Host ""
Write-Host "Current portproxy table:" -ForegroundColor Cyan
& netsh interface portproxy show all

Write-Host ""
Write-Host "Current WECRYPTO firewall rules:" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "WECRYPTO Tor *" | Select-Object DisplayName, Enabled, Direction, Action | Format-Table -AutoSize
