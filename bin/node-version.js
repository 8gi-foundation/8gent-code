// The Node build needs node:sqlite (Node 22.5+). Pure so a test can feed it versions.
export function nodeTooOld(version) {
	const [major, minor] = String(version).split(".").map(Number);
	return major < 22 || (major === 22 && minor < 5);
}

export function tooOldMessage(version) {
	return [
		`8gent needs Node 22.5 or newer (found ${version}). Install Node 22 or Bun.`,
		"  Debian / Kali: curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh && apt-get install -y nodejs",
		"  Arch:          pacman -Syu --noconfirm nodejs npm",
		"  Any Linux:     install nvm (https://github.com/nvm-sh/nvm), then: nvm install 22",
	].join("\n");
}
