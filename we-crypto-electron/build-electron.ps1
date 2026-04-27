param(
    [string]$DeployDrive = "F:"
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

Write-Host "Building Electron wrapper (deploy: $DeployDrive)"

# Copy needed backtest JS files into electron app dir
Write-Host "Copying JS backtest files into electron app folder..."
$root = Resolve-Path ..\
Copy-Item -Path (Join-Path $root 'backtest-1yr.js') -Destination . -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $root 'backtest-runner.js') -Destination . -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $root 'backtest-alltime.js') -Destination . -Force -ErrorAction SilentlyContinue

# Install deps
Write-Host "Installing Electron dependencies (npm install)..."
if (!(Test-Path "node_modules")) { npm install }

# Build distributable
Write-Host "Running electron-builder (this may take several minutes)..."
npm run dist

# Find built exe
$distDir = Join-Path $scriptDir 'dist'
$exe = Get-ChildItem -Path $distDir -Filter *.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
if (!$exe) {
    Write-Host "No exe found in dist. Check electron-builder logs." -ForegroundColor Red
    exit 1
}

$builtExe = $exe.FullName
Write-Host "Built exe: $builtExe"

# Copy to drive root
$driveRoot = $DeployDrive.TrimEnd('\') + '\\'
$dest = Join-Path $driveRoot (Split-Path $builtExe -Leaf)
Write-Host "Copying to $dest"
Copy-Item -Path $builtExe -Destination $dest -Force

Write-Host "Electron build and deploy complete. Deployed to $dest" -ForegroundColor Green
