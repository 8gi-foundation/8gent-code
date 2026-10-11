# 8gent Code installer for Windows (Windows PowerShell 5.1 and PowerShell 7).
#
#   irm https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.ps1 | iex
#
# Downloads the self-contained 8gent.exe from the newest GitHub release that
# carries it, installs it to %LOCALAPPDATA%\Programs\8gent\bin and puts that
# folder first on your user PATH. No Bun, Node, npm or admin rights needed.
# The macOS and Linux counterpart is scripts/install.sh.
#
# Trust chain, in order; any failure stops the install with nothing changed:
#   1. Only https, only github.com release downloads, and every redirect hop
#      checked against GitHub's download hosts.
#   2. SHA256SUMS is signed with the release signing key embedded below
#      (minisign). It is checked with minisign.exe when that is installed.
#   3. The exe is checked against GitHub's build provenance attestation with
#      `gh attestation verify` when the GitHub CLI is installed and signed in.
#   4. The exe's SHA256 must match SHA256SUMS, and its own --version must name
#      the release, before it replaces anything.
# Set EIGHT_REQUIRE_VERIFIED=1 to refuse an install unless step 2 or 3 ran.
#
# Settings (environment variables, all optional):
#   EIGHT_VERSION           install this version (0.20.0 or v0.20.0) instead of the newest
#   EIGHT_INSTALL_DIR       where 8gent.exe goes
#   EIGHT_REPO              GitHub owner/repo (default: 8gi-foundation/8gent-code)
#   EIGHT_RELEASES_URL      the releases list (https, or http://127.0.0.1 for tests)
#   EIGHT_NO_MODIFY_PATH    1 = leave your PATH alone
#   EIGHT_REQUIRE_VERIFIED  1 = refuse unless the signature or attestation was checked
#
# It never replaces a newer 8gent with an older one unless EIGHT_VERSION asks
# for that version by name.

# Release signing key (minisign public key, base64). Kept identical to
# scripts/release-signing.pub by scripts/lib/install-sh.test.ts. Empty until
# the maintainer generates the release key; see that file.
$EightSigningKey = ''

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

	$local = $false
	if ($releasesUrl -match '^http://127\.0\.0\.1[:/]') { $local = $true }
	elseif ($releasesUrl -notmatch '^https://') { throw "EIGHT_RELEASES_URL must be https (or http://127.0.0.1 for tests): $releasesUrl" }
	# A local test server may supply its own key; a real install trusts only the embedded one.
	$key = $EightSigningKey
	if ($local -and $env:EIGHT_TEST_SIGNING_KEY) { $key = $env:EIGHT_TEST_SIGNING_KEY }

	function Test-EightUrl([string]$url, [string]$kind) {
		if ($local) { return ($url -match '^http://127\.0\.0\.1[:/]') }
		if ($url -notmatch '^https://') { return $false }
		if ($kind -eq 'list') { return $true }
		if ($kind -eq 'asset') { return $url.StartsWith("https://github.com/$repo/releases/download/", [StringComparison]::Ordinal) }
		$h = ([Uri]$url).Host.ToLowerInvariant()
		return @('github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com') -contains $h
	}

	# Download $url to $outFile, following at most 5 redirects, each one checked.
	function Get-EightFile([string]$url, [string]$outFile, [string]$kind) {
		if (-not (Test-EightUrl $url $kind)) { throw "Refusing to download from $url" }
		for ($hop = 0; $hop -le 5; $hop++) {
			$req = [System.Net.HttpWebRequest]::Create($url)
			$req.AllowAutoRedirect = $false
			$req.UserAgent = '8gent-installer'
			$req.Accept = if ($kind -eq 'list') { 'application/vnd.github+json' } else { 'application/octet-stream' }
			$resp = $null
			try {
				$resp = $req.GetResponse()
			} catch [System.Net.WebException] {
				$resp = $_.Exception.Response
				if (-not $resp) { throw "Download failed: $url ($($_.Exception.Message))" }
			}
			try {
				$code = [int]$resp.StatusCode
				if ($code -ge 300 -and $code -lt 400) {
					$next = (New-Object Uri ([Uri]$url), ([string]$resp.Headers['Location'])).AbsoluteUri
					if (-not (Test-EightUrl $next 'hop')) { throw "Refusing a redirect to $next" }
					$url = $next
					continue
				}
				if ($code -ne 200) { throw "Download failed: $url (HTTP $code)" }
				$in = $resp.GetResponseStream()
				$out = [IO.File]::Create($outFile)
				try { $in.CopyTo($out) } finally { $out.Close(); $in.Close() }
				return
			} finally {
				$resp.Close()
			}
		}
		throw "Too many redirects for $url"
	}

	# Run a program with a time limit; returns @{ Code; Out }. Never throws on a non-zero exit.
	function Invoke-EightProcess([string]$file, [string[]]$arguments, [int]$seconds) {
		$psi = New-Object System.Diagnostics.ProcessStartInfo
		$psi.FileName = $file
		$psi.Arguments = (($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ')
		$psi.UseShellExecute = $false
		$psi.RedirectStandardOutput = $true
		$psi.RedirectStandardError = $true
		$psi.CreateNoWindow = $true
		try {
			$p = [System.Diagnostics.Process]::Start($psi)
		} catch {
			return @{ Code = -1; Out = '' }
		}
		$outTask = $p.StandardOutput.ReadToEndAsync()
		$errTask = $p.StandardError.ReadToEndAsync()
		if (-not $p.WaitForExit($seconds * 1000)) {
			try { $p.Kill() } catch {}
			return @{ Code = -2; Out = '' }
		}
		$p.WaitForExit()
		return @{ Code = $p.ExitCode; Out = $outTask.Result }
	}

	function Get-EightVersion([string]$exe) {
		if (-not (Test-Path -LiteralPath $exe)) { return $null }
		$r = Invoke-EightProcess $exe @('--version') 15
		if ($r.Code -eq 0 -and $r.Out -match '8gent Code v(\d+\.\d+\.\d+)') { return $Matches[1] }
		return $null
	}

	if (-not [Environment]::Is64BitOperatingSystem) { throw '8gent needs 64-bit Windows.' }
	# x64 runs natively on Intel and AMD and under emulation on Windows on Arm.
	# The baseline build is for CPUs without AVX2; it is tried when x64 will not start.
	$assets = @('8gent-windows-x64.exe', '8gent-windows-x64-baseline.exe')

	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('8gent-install-' + [guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		$listFile = Join-Path $tmp 'releases.json'
		Get-EightFile $releasesUrl $listFile 'list'
		$releases = Get-Content -LiteralPath $listFile -Raw | ConvertFrom-Json

		# Newest published vX.Y.Z release that carries the x64 exe and SHA256SUMS.
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
		function Get-AssetUrl([string]$name) {
			$a = $pick.Release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
			if (-not $a) { return $null }
			$u = [string]$a.browser_download_url
			if (-not (Test-EightUrl $u 'asset')) { throw "Refusing a download URL outside $repo's releases: $u" }
			return $u
		}

		$target = Join-Path $installDir '8gent.exe'
		$current = Get-EightVersion $target
		if ($current -and (-not $want) -and (([version]$current) -gt ([version]$version))) {
			Write-Host "8gent v$current is already installed at $target, newer than the newest release v$version. Nothing changed."
			return
		}
		if ($current -eq $version) {
			Write-Host "8gent v$version is already installed at $target."
			return
		}

		$sumsFile = Join-Path $tmp 'SHA256SUMS'
		Get-EightFile (Get-AssetUrl 'SHA256SUMS') $sumsFile 'asset'
		$verified = $false
		if ($key) {
			$sigUrl = Get-AssetUrl 'SHA256SUMS.minisig'
			if (-not $sigUrl) { throw "Release v$version has no SHA256SUMS.minisig; refusing unsigned checksums." }
			$sigFile = Join-Path $tmp 'SHA256SUMS.minisig'
			Get-EightFile $sigUrl $sigFile 'asset'
			$minisign = Get-Command minisign -ErrorAction SilentlyContinue
			if ($minisign) {
				$r = Invoke-EightProcess $minisign.Source @('-q', '-V', '-m', $sumsFile, '-x', $sigFile, '-P', $key) 60
				if ($r.Code -ne 0) { throw "SHA256SUMS for v$version does not carry a valid release signature. Nothing installed." }
				Write-Host 'Release signature on SHA256SUMS: verified.'
				$verified = $true
			}
		}
		$sums = @{}
		foreach ($line in Get-Content -LiteralPath $sumsFile) {
			if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') { $sums[$Matches[2].Trim()] = $Matches[1].ToLower() }
		}
		$gh = Get-Command gh -ErrorAction SilentlyContinue
		$ghReady = $false
		if ($gh) { $ghReady = ((Invoke-EightProcess $gh.Source @('auth', 'status') 30).Code -eq 0) }

		$chosen = $null
		foreach ($name in $assets) {
			$assetUrl = Get-AssetUrl $name
			if (-not $assetUrl) { continue }
			if (-not $sums.ContainsKey($name)) { throw "SHA256SUMS for v$version does not list $name; refusing an unverified download." }
			$file = Join-Path $tmp $name
			Write-Host "Downloading 8gent v$version ($name)..."
			Get-EightFile $assetUrl $file 'asset'
			$actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
			if ($actual -ne $sums[$name]) { throw "Checksum mismatch for $name (expected $($sums[$name]), got $actual). Nothing installed." }
			if ($ghReady) {
				$r = Invoke-EightProcess $gh.Source @('attestation', 'verify', $file, '--repo', $repo) 120
				if ($r.Code -ne 0) { throw "GitHub build attestation for $name v$version did not verify. Nothing installed." }
				Write-Host 'GitHub build attestation: verified.'
				$verified = $true
			}
			$got = Get-EightVersion $file
			if ($got -eq $version) { $chosen = $file; break }
			Write-Host "$name did not start on this machine (reported '$got'); trying the next build."
		}
		if (-not $chosen) { throw "No 8gent v$version build started on this machine. Nothing installed." }
		if (-not $verified) {
			if ($env:EIGHT_REQUIRE_VERIFIED -eq '1') {
				throw 'EIGHT_REQUIRE_VERIFIED=1 but neither minisign nor a signed-in GitHub CLI (gh) is available to verify the release.'
			}
			Write-Warning 'Only the SHA256 checksum was checked. Install minisign, or the GitHub CLI and run gh auth login, to also verify the release signature or build attestation.'
		}

		# Stage beside the target, then rename: a running 8gent.exe cannot be
		# overwritten but can be renamed. Any failure puts the old exe back.
		New-Item -ItemType Directory -Force -Path $installDir | Out-Null
		$staged = Join-Path $installDir ('.8gent.' + [guid]::NewGuid().ToString('N') + '.new')
		Copy-Item -LiteralPath $chosen -Destination $staged
		$old = "$target.old"
		$movedOld = $false
		try {
			if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
			if (Test-Path -LiteralPath $target) {
				if (Test-Path -LiteralPath $old) { $old = "$target.old-" + [guid]::NewGuid().ToString('N') }
				Move-Item -LiteralPath $target -Destination $old
				$movedOld = $true
			}
			Move-Item -LiteralPath $staged -Destination $target
		} catch {
			if ($movedOld -and -not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $old -Destination $target }
			Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
			throw "Could not replace $target ($($_.Exception.Message)). The previous 8gent is unchanged."
		}
	} finally {
		Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
	}

	Write-Host "Installed 8gent v$version to $target"
	$same = { param($a) $a.TrimEnd('\') -ieq $installDir.TrimEnd('\') }
	if ($env:EIGHT_NO_MODIFY_PATH -ne '1') {
		# First on the user PATH, so an older npm copy in %APPDATA%\npm does not win.
		$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		$parts = @($userPath -split ';' | Where-Object { $_ -and -not (& $same $_) })
		[Environment]::SetEnvironmentVariable('Path', ((@($installDir) + $parts) -join ';'), 'User')
		$env:Path = $installDir + ';' + (($env:Path -split ';' | Where-Object { $_ -and -not (& $same $_) }) -join ';')
		Write-Host "Put $installDir first on your user PATH. New terminals pick it up; this one already has it."
	}
	$found = Get-Command 8gent -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($found -and ($found.Source -ine $target)) {
		Write-Warning "``8gent`` resolves to $($found.Source), not $target (often an older npm install, or a machine-wide PATH entry)."
		Write-Warning 'Fix: npm uninstall -g @8gi-foundation/8gent-code, then open a new terminal.'
	} elseif (-not $found) {
		Write-Host "$installDir is not on this terminal's PATH (EIGHT_NO_MODIFY_PATH=1). Run it as: & '$target'"
	} else {
		Write-Host 'Run: 8gent'
	}
}

Install-Eight
