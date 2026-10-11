# 8gent Code installer for Windows (Windows PowerShell 5.1 and PowerShell 7).
#
#   irm https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.ps1 | iex
#
# Downloads the self-contained 8gent.exe from the newest GitHub release that
# carries it, checks it against that release's SHA256SUMS, installs it to
# %LOCALAPPDATA%\Programs\8gent\bin and puts that folder on your user PATH.
# No Bun, Node, npm or admin rights needed. The macOS and Linux counterpart is
# scripts/install.sh.
#
# Settings (environment variables, all optional):
#   EIGHT_VERSION         install this version (0.20.0 or v0.20.0) instead of the newest
#   EIGHT_INSTALL_DIR     where 8gent.exe goes
#   EIGHT_REPO            GitHub owner/repo (default: 8gi-foundation/8gent-code)
#   EIGHT_RELEASES_URL    the releases list to read (default: the GitHub API for EIGHT_REPO)
#   EIGHT_NO_MODIFY_PATH  set to 1 to leave your PATH alone
#
# It never replaces a newer 8gent with an older one unless EIGHT_VERSION asks
# for that version by name. Nothing is changed if the download, the checksum
# or the first run of the new 8gent.exe fails.

function Install-Eight {
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'
	# Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
	try {
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	} catch {}

	$repo = if ($env:EIGHT_REPO) { $env:EIGHT_REPO } else { '8gi-foundation/8gent-code' }
	$releasesUrl = if ($env:EIGHT_RELEASES_URL) { $env:EIGHT_RELEASES_URL } else { "https://api.github.com/repos/$repo/releases?per_page=100" }
	$installDir = if ($env:EIGHT_INSTALL_DIR) { $env:EIGHT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\8gent\bin' }
	$want = if ($env:EIGHT_VERSION) { $env:EIGHT_VERSION.TrimStart('v') } else { '' }

	if (-not [Environment]::Is64BitOperatingSystem) {
		throw '8gent needs 64-bit Windows.'
	}
	# x64 runs natively on Intel and AMD and under emulation on Windows on Arm.
	# The baseline build is for CPUs without AVX2; it is tried when x64 will not start.
	$assets = @('8gent-windows-x64.exe', '8gent-windows-x64-baseline.exe')

	function Get-EightVersion([string]$exe) {
		if (-not (Test-Path -LiteralPath $exe)) { return $null }
		try {
			$out = & $exe --version 2>$null | Out-String
		} catch {
			return $null
		}
		if ($out -match '8gent Code v(\d+\.\d+\.\d+)') { return $Matches[1] }
		return $null
	}

	function Test-VersionGreater([string]$a, [string]$b) {
		return ([version]$a) -gt ([version]$b)
	}

	$headers = @{ 'User-Agent' = '8gent-installer'; 'Accept' = 'application/vnd.github+json' }
	try {
		$releases = Invoke-RestMethod -Uri $releasesUrl -Headers $headers -UseBasicParsing
	} catch {
		throw "Could not read the release list at ${releasesUrl}: $($_.Exception.Message)"
	}

	# Newest vX.Y.Z release that carries the x64 exe and SHA256SUMS. Drafts are
	# not visible here; pre-releases and other tag shapes are skipped.
	$candidates = @()
	foreach ($r in @($releases)) {
		if ($r.draft -or $r.prerelease) { continue }
		if (-not ($r.tag_name -match '^v(\d+\.\d+\.\d+)$')) { continue }
		$v = $Matches[1]
		$names = @($r.assets | ForEach-Object { $_.name })
		if (($names -notcontains $assets[0]) -or ($names -notcontains 'SHA256SUMS')) { continue }
		$candidates += [pscustomobject]@{ Version = $v; Release = $r }
	}
	if ($want) {
		$pick = $candidates | Where-Object { $_.Version -eq $want } | Select-Object -First 1
		if (-not $pick) { throw "Release v$want has no $($assets[0]) (see https://github.com/$repo/releases)." }
	} else {
		$pick = $candidates | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
		if (-not $pick) { throw "No release carries $($assets[0]) yet (see https://github.com/$repo/releases)." }
	}
	$version = $pick.Version

	$target = Join-Path $installDir '8gent.exe'
	$current = Get-EightVersion $target
	if ($current -and (-not $want) -and (Test-VersionGreater $current $version)) {
		Write-Host "8gent v$current is already installed at $target, newer than the newest release v$version. Nothing changed."
		return
	}
	if ($current -eq $version) {
		Write-Host "8gent v$version is already installed at $target."
		return
	}

	$tmp = Join-Path ([IO.Path]::GetTempPath()) ("8gent-install-" + [guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		$sumsAsset = $pick.Release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
		$sumsFile = Join-Path $tmp 'SHA256SUMS'
		Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsFile -Headers @{ 'User-Agent' = '8gent-installer' } -UseBasicParsing
		$sums = @{}
		foreach ($line in Get-Content -LiteralPath $sumsFile) {
			if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') { $sums[$Matches[2].Trim()] = $Matches[1].ToLower() }
		}

		$installed = $null
		foreach ($name in $assets) {
			$asset = $pick.Release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
			if (-not $asset) { continue }
			if (-not $sums.ContainsKey($name)) { throw "SHA256SUMS for v$version does not list $name; refusing an unverified download." }
			$file = Join-Path $tmp $name
			Write-Host "Downloading 8gent v$version ($name)..."
			Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -Headers @{ 'User-Agent' = '8gent-installer' } -UseBasicParsing
			$actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
			if ($actual -ne $sums[$name]) {
				throw "Checksum mismatch for $name (expected $($sums[$name]), got $actual). Nothing installed."
			}
			$got = Get-EightVersion $file
			if ($got -eq $version) { $installed = $file; break }
			Write-Host "$name did not start on this machine (reported '$got'); trying the next build."
		}
		if (-not $installed) { throw "No 8gent v$version build started on this machine. Nothing installed." }

		New-Item -ItemType Directory -Force -Path $installDir | Out-Null
		# A running 8gent.exe cannot be overwritten, but it can be renamed.
		if (Test-Path -LiteralPath $target) {
			$old = "$target.old"
			if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
			Move-Item -LiteralPath $target -Destination $old -Force
		}
		Copy-Item -LiteralPath $installed -Destination $target -Force
	} finally {
		Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
	}

	Write-Host "Installed 8gent v$version to $target"
	$onPath = @($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $installDir.TrimEnd('\') }).Count -gt 0
	if ($env:EIGHT_NO_MODIFY_PATH -eq '1') {
		if (-not $onPath) { Write-Host "$installDir is not on your PATH (EIGHT_NO_MODIFY_PATH=1, left as is)." }
	} elseif (-not $onPath) {
		$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		$parts = @($userPath -split ';' | Where-Object { $_ })
		if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $installDir.TrimEnd('\') })) {
			[Environment]::SetEnvironmentVariable('Path', (($parts + $installDir) -join ';'), 'User')
		}
		$env:Path = "$env:Path;$installDir"
		Write-Host "Added $installDir to your user PATH. New terminals pick it up; this one already has it."
	}
	Write-Host 'Run: 8gent'
}

Install-Eight
