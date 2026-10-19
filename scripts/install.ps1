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
#      (minisign). Once a key is embedded the signature is REQUIRED: it is
#      checked with minisign.exe from PATH, or else with minisign 0.12
#      downloaded from github.com/jedisct1/minisign and pinned by the SHA256
#      below. EIGHT_ALLOW_UNVERIFIED=1 is the explicit opt-out.
#   3. The exe is checked against GitHub's build provenance attestation
#      (signed by release-binaries.yml for this tag) with `gh attestation
#      verify` when the GitHub CLI is installed and signed in.
#   4. The exe's SHA256 must match SHA256SUMS, and its own --version must name
#      the release, before it replaces anything.
#
# Settings (environment variables, all optional):
#   EIGHT_VERSION           install this version (0.20.0 or v0.20.0) instead of the newest
#   EIGHT_INSTALL_DIR       where 8gent.exe goes
#   EIGHT_REPO              GitHub owner/repo (default: 8gi-foundation/8gent-code)
#   EIGHT_RELEASES_URL      the releases list (https, or http://127.0.0.1 for tests)
#   EIGHT_NO_MODIFY_PATH    1 = leave your PATH alone
#   EIGHT_ALLOW_UNVERIFIED  1 = continue when a release key exists but no minisign can run
#
# It never replaces a newer 8gent with an older one unless EIGHT_VERSION asks
# for that version by name.

# Release signing key (minisign public key, base64). Kept identical to
# scripts/release-signing.pub by scripts/lib/install-sh.test.ts. Empty until
# the maintainer generates the release key; see that file.
$EightSigningKey = ''

# Pinned signature verifier, used only when minisign is not on PATH: release
# 0.12 of github.com/jedisct1/minisign, checked against jedisct1's published
# signature when pinned.
$EightMinisignVersion = '0.12'
$EightMinisignWinSha256 = '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479'

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
		$isLocal = ($url -match '^http://127\.0\.0\.1[:/]')
		if ($kind -eq 'verifier') {
			if ($local -and $isLocal) { return $true }
			return $url.StartsWith('https://github.com/jedisct1/minisign/releases/download/', [StringComparison]::Ordinal)
		}
		if ($kind -eq 'verifier-hop') {
			if ($local -and $isLocal) { return $true }
			$kind = 'hop'
		} elseif ($local) {
			return $isLocal
		}
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
			# Optional token (CI smoke only), first hop of the release list on api.github.com only.
			if ($kind -eq 'list' -and $hop -eq 0 -and $env:GITHUB_TOKEN -and ([Uri]$url).Host -eq 'api.github.com') {
				$req.Headers.Add('Authorization', "Bearer $env:GITHUB_TOKEN")
			}
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
					$hopKind = if ($kind -eq 'verifier') { 'verifier-hop' } else { 'hop' }
					if (-not (Test-EightUrl $next $hopKind)) { throw "Refusing a redirect to $next" }
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
		# The release list can be rate limited on an unauthenticated runner (#4468):
		# retry 3 times with 2 s, 4 s, 8 s backoff; the last error carries the HTTP status.
		$delay = 2
		for ($attempt = 0; ; $attempt++) {
			try { Get-EightFile $releasesUrl $listFile 'list'; break }
			catch {
				if ($attempt -ge 3) { throw "Could not read the release list at $releasesUrl ($($_.Exception.Message))" }
				Start-Sleep -Seconds $(if ($env:EIGHT_TEST_RETRY_DELAY) { [int]$env:EIGHT_TEST_RETRY_DELAY } else { $delay })
				$delay *= 2
			}
		}
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

		# Check the URLs before anything is downloaded.
		foreach ($n in @($assets[0], 'SHA256SUMS')) { [void](Get-AssetUrl $n) }

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
		if ($key) {
			$sigUrl = Get-AssetUrl 'SHA256SUMS.minisig'
			if (-not $sigUrl) { throw "Release v$version has no SHA256SUMS.minisig; refusing unsigned checksums." }
			$sigFile = Join-Path $tmp 'SHA256SUMS.minisig'
			Get-EightFile $sigUrl $sigFile 'asset'
			$msBin = $null
			$onPath = Get-Command minisign -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($onPath) {
				$msBin = $onPath.Source
			} else {
				# The pinned verifier: exact release, SHA256 checked before it runs.
				$msZip = "minisign-$EightMinisignVersion-win64.zip"
				$msUrl = "https://github.com/jedisct1/minisign/releases/download/$EightMinisignVersion/$msZip"
				$msSha = $EightMinisignWinSha256
				if ($local -and $env:EIGHT_TEST_MINISIGN_URL) {
					$msUrl = $env:EIGHT_TEST_MINISIGN_URL
					if ($env:EIGHT_TEST_MINISIGN_SHA256) { $msSha = $env:EIGHT_TEST_MINISIGN_SHA256 }
				}
				Write-Host "Fetching the pinned signature verifier (minisign $EightMinisignVersion)..."
				$msFile = Join-Path $tmp $msZip
				Get-EightFile $msUrl $msFile 'verifier'
				$gotSha = (Get-FileHash -LiteralPath $msFile -Algorithm SHA256).Hash.ToLower()
				if ($gotSha -ne $msSha) { throw "The downloaded minisign does not match its pinned SHA256 (expected $msSha, got $gotSha). Nothing installed." }
				$msDir = Join-Path $tmp 'minisign'
				Expand-Archive -LiteralPath $msFile -DestinationPath $msDir -Force
				$msArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
				$msBin = Join-Path $msDir "minisign-win64\$msArch\minisign.exe"
				if (-not (Test-Path -LiteralPath $msBin)) { $msBin = $null }
			}
			if ($msBin) {
				$r = Invoke-EightProcess $msBin @('-q', '-V', '-m', $sumsFile, '-x', $sigFile, '-P', $key) 60
				if ($r.Code -ne 0) { throw "SHA256SUMS for v$version does not carry a valid release signature. Nothing installed." }
				Write-Host 'Release signature on SHA256SUMS: verified.'
			} elseif ($env:EIGHT_ALLOW_UNVERIFIED -eq '1') {
				Write-Warning 'The release signature was NOT checked (no minisign for this machine), as EIGHT_ALLOW_UNVERIFIED=1 asked.'
			} else {
				throw 'Cannot check the release signature: install minisign and run this again, or set EIGHT_ALLOW_UNVERIFIED=1 to skip it.'
			}
		} else {
			Write-Warning 'This release has no signing key yet; only the SHA256 checksum (and the GitHub attestation, if gh is signed in) is checked.'
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
				$r = Invoke-EightProcess $gh.Source @('attestation', 'verify', $file, '--repo', $repo, '--signer-workflow', "$repo/.github/workflows/release-binaries.yml", '--source-ref', "refs/tags/v$version") 120
				if ($r.Code -ne 0) { throw "GitHub build attestation for $name v$version did not verify. Nothing installed." }
				Write-Host 'GitHub build attestation: verified.'
			}
			$got = Get-EightVersion $file
			if ($got -eq $version) { $chosen = $file; break }
			Write-Host "$name did not start on this machine (reported '$got'); trying the next build."
		}
		if (-not $chosen) { throw "No 8gent v$version build started on this machine. Nothing installed." }

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
		# Read and written raw as REG_EXPAND_SZ, so entries like %USERPROFILE%\bin
		# keep their variables instead of being frozen to today's values.
		$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
		try {
			$userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
			$parts = @($userPath -split ';' | Where-Object { $_ -and -not (& $same $_) })
			$envKey.SetValue('Path', ((@($installDir) + $parts) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
		} finally {
			$envKey.Close()
		}
		# Tell running programs (Explorer, new terminals) that the environment changed.
		[Environment]::SetEnvironmentVariable('EIGHT_INSTALL_PATH_TOUCH', '1', 'User')
		[Environment]::SetEnvironmentVariable('EIGHT_INSTALL_PATH_TOUCH', $null, 'User')
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
