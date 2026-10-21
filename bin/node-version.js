// The Node build needs node:sqlite (Node 22.5+). Pure so a test can feed it versions.
export function nodeTooOld(version) {
	const [major, minor] = String(version).split(".").map(Number);
	return major < 22 || (major === 22 && minor < 5);
}

export function tooOldMessage(version) {
	return `8gent needs Node 22.5 or newer (found ${version}). Install Node 22 or Bun.`;
}
