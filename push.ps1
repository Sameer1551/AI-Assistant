# push.ps1
# PowerShell script to fully commit and push this project to the GitHub remote repository.

$RemoteUrl = "https://github.com/Sameer1551/AI-Assistant.git"
$BranchName = "main"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "[*] Initializing Git Push Automation Script" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Check if Git is installed
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not installed or not in your PATH. Please install Git."
    Exit 1
}

# 2. Check if .git directory exists, if not initialize it
if (!(Test-Path ".git")) {
    Write-Host "[!] Git repository not detected. Initializing new Git repository..." -ForegroundColor Yellow
    git init
    # Rename default branch to main
    git checkout -b $BranchName
}

# 3. Handle Git Remote URL
Write-Host "[*] Verifying remote origin configuration..." -ForegroundColor Yellow
$ExistingRemotes = git remote -v
if ($ExistingRemotes -like "*origin*") {
    # Check if origin URL matches the target URL
    $OriginUrl = (git remote get-url origin).Trim()
    if ($OriginUrl -ne $RemoteUrl) {
        Write-Host "[*] Updating remote origin URL to: $RemoteUrl" -ForegroundColor Yellow
        git remote set-url origin $RemoteUrl
    } else {
        Write-Host "[+] Remote origin is already correctly set to: $RemoteUrl" -ForegroundColor Green
    }
} else {
    Write-Host "[+] Adding remote origin: $RemoteUrl" -ForegroundColor Yellow
    git remote add origin $RemoteUrl
}

# 4. Stage all changes
Write-Host "[*] Staging all files..." -ForegroundColor Yellow
git add -A

# 5. Check if there are changes to commit
$GitStatus = git status --porcelain
if ([string]::IsNullOrEmpty($GitStatus)) {
    Write-Host "[+] No changes to commit. Working directory is clean." -ForegroundColor Green
} else {
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $CommitMsg = "Auto-commit: Update AI Assistant ($Timestamp)"
    Write-Host "[*] Committing changes with message: '$CommitMsg'..." -ForegroundColor Yellow
    git commit -m $CommitMsg
}

# 6. Push to remote
Write-Host "[*] Pushing to branch '$BranchName' on origin..." -ForegroundColor Yellow
git push -u origin $BranchName --force

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "[+] Project successfully pushed to GitHub!" -ForegroundColor Green
    Write-Host "[+] Repository: $RemoteUrl" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[-] Failed to push changes to GitHub. Please check your credentials or internet connection." -ForegroundColor Red
}
Write-Host "=========================================" -ForegroundColor Cyan
