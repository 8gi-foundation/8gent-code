/**
 * 8gent Code - /keys screen
 *
 * Enter a provider API key without it touching the transcript. The key is typed
 * into a field owned by this screen only: it is never put in React state that
 * renders, never passed to addSystemMessage, never sent through the chat input
 * (so it never reaches the session journal, turn log, memory or scrollback).
 * The field renders one bullet per character. The list shows provider name and
 * the last four characters, nothing more.
 *
 * Keys: Up/Down choose, Enter enter or replace a key, D delete, Esc close.
 * While typing: Enter saves, Esc cancels, Backspace edits.
 */

import { Box, Text, useInput } from "ink";
import React, { useRef, useState } from "react";
import { getProviderManager } from "../../../../packages/providers/index.js";
import {
	type VaultKeyInfo,
	deleteVaultKey,
	currentKeyOwner,
	listVaultKeys,
	maskKey,
	storeVaultKey,
} from "../../../../packages/secrets/key-vault.js";

export interface KeyTarget {
	/** Provider display name. */
	label: string;
	/** Vault entry the provider resolves: `apiKeyRef`, else `apiKeyEnv`. */
	vaultName: string;
}

/** Providers that take a key, each with the vault entry it resolves. */
export function providerKeyTargets(): KeyTarget[] {
	return getProviderManager()
		.listProviders()
		.filter((p) => p.apiKeyEnv || p.apiKeyRef)
		.map((p) => ({ label: p.displayName, vaultName: (p.apiKeyRef || p.apiKeyEnv) as string }));
}

/** Display names of providers still holding a plain-text key in providers.json. */
export function plainKeyProviderNames(): string[] {
	return getProviderManager()
		.listProviders()
		.filter((p) => p.apiKey)
		.map((p) => p.displayName);
}

export interface KeyVaultScreenProps {
	targets?: KeyTarget[];
	onClose: () => void;
	/** Providers still carrying a plain-text key in providers.json. */
	plainKeyProviders?: string[];
	/** Test seams. Default to the real vault. */
	store?: (name: string, value: string) => string;
	remove?: (name: string) => boolean;
	list?: () => VaultKeyInfo[];
}

export function KeyVaultScreen({
	targets = providerKeyTargets(),
	onClose,
	plainKeyProviders = plainKeyProviderNames(),
	store = storeVaultKey,
	remove = deleteVaultKey,
	list = listVaultKeys,
}: KeyVaultScreenProps) {
	const [index, setIndex] = useState(0);
	const [stored, setStored] = useState<VaultKeyInfo[]>(() => list());
	const [entering, setEntering] = useState(false);
	// Only the LENGTH is state. The characters live in a ref and are never rendered.
	const [typedLength, setTypedLength] = useState(0);
	const [note, setNote] = useState("");
	const secret = useRef("");

	const refresh = () => setStored(list());
	const clearSecret = () => {
		secret.current = "";
		setTypedLength(0);
	};

	const save = () => {
		const target = targets[index];
		const value = secret.current.trim();
		if (!target || !value) {
			setNote("Nothing entered.");
			clearSecret();
			setEntering(false);
			return;
		}
		try {
			const backend = store(target.vaultName, value);
			setNote(`Saved key for ${target.label} (${backend}).`);
		} catch {
			// Never echo the thrown message: it is the vault's, not ours to vouch for.
			setNote(`Could not save the key for ${target.label}.`);
		}
		clearSecret();
		setEntering(false);
		refresh();
	};

	useInput((input, key) => {
		if (entering) {
			if (key.escape) {
				clearSecret();
				setEntering(false);
				setNote("Cancelled. Nothing saved.");
				return;
			}
			if (key.ctrl) return;
			if (key.backspace || key.delete) {
				secret.current = secret.current.slice(0, -1);
				setTypedLength(secret.current.length);
				return;
			}
			if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;
			// A paste can arrive with its Enter in the same chunk ("key\r").
			const submit = key.return || /[\r\n]/.test(input);
			const text = input.replace(/[\r\n]/g, "");
			if (text) {
				secret.current += text;
				setTypedLength(secret.current.length);
			}
			if (submit) save();
			return;
		}
		if (key.escape || input === "q") return onClose();
		if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
		else if (key.downArrow) setIndex((i) => Math.min(targets.length - 1, i + 1));
		else if (key.return && targets[index]) {
			clearSecret();
			setNote("");
			setEntering(true);
		} else if ((input === "d" || input === "D") && targets[index]) {
			const t = targets[index];
			const gone = remove(t.vaultName);
			setNote(gone ? `Deleted key for ${t.label}.` : `No stored key for ${t.label}.`);
			refresh();
		}
	});

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold>Provider keys</Text>
			<Text dimColor>
				Stored in the OS keychain (file vault if none), for {currentKeyOwner()} only. Never shown,
				never logged.
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{targets.length === 0 && <Text dimColor>No provider here needs a key.</Text>}
				{targets.map((t, i) => {
					const info = stored.find((s) => s.name === t.vaultName);
					return (
						<Text key={t.vaultName + t.label} color={i === index ? "cyan" : undefined}>
							{i === index ? "> " : "  "}
							{t.label.padEnd(22)}
							{info ? `****${info.last4}` : "not set"}
						</Text>
					);
				})}
			</Box>
			{entering && targets[index] && (
				<Box marginTop={1} flexDirection="column">
					<Text>Key for {targets[index].label}:</Text>
					<Text>{`[ ${maskKey(secret.current)}${typedLength === 0 ? "" : " "}]`}</Text>
					<Text dimColor>Enter saves. Esc cancels.</Text>
				</Box>
			)}
			{plainKeyProviders.length > 0 && (
				<Box marginTop={1}>
					<Text color="yellow">
						Plain-text key in providers.json for: {plainKeyProviders.join(", ")}. Enter it here and remove
						it from the file.
					</Text>
				</Box>
			)}
			{note !== "" && <Text>{note}</Text>}
			{!entering && <Text dimColor>Up/Down choose  Enter set key  D delete  Esc close</Text>}
		</Box>
	);
}
