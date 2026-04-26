export function randomId(): string {
	return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mask(s: string): string {
	if (s.length <= 8) return "***";
	return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
