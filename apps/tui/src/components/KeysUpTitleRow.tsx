/**
 * KeysUpTitleRow - the one row of header the keys-up layout keeps (#4967).
 *
 * A phone with the keyboard open has 14 to 16 rows, so the brand box, the tab
 * row and the tab underline fold into one line. With several tabs the line is
 * the tab bar (numbers, titles, lamps), the same row, without its rule. With
 * one tab it is the brand and the branch:
 *
 *   8gent v0.20.27  ⎇ main
 *
 * A pending approval still shows its ASK chip here, in the one orange; the
 * status row and the approval card say the rest. Theme tokens only.
 */

import { Box, Text } from "ink";
import type React from "react";
import type { WorkspaceTab } from "../hooks/useWorkspaceTabs.js";
import { cellWidth } from "../lib/header-layout.js";
import { t } from "../theme.js";
import { TabBar } from "./TabBar.js";

type TabBarProps = React.ComponentProps<typeof TabBar>;

interface KeysUpTitleRowProps {
	tabs: WorkspaceTab[];
	onSwitch: TabBarProps["onSwitch"];
	isTabProcessing?: TabBarProps["isTabProcessing"];
	lampFor?: TabBarProps["lampFor"];
	permFor?: TabBarProps["permFor"];
	version?: string;
	branch: string;
	approvalPending: boolean;
	width: number;
}

const ASK = "ASK";

export function keysUpTitleText(
	version: string | undefined,
	branch: string,
	width: number,
): string {
	const head = `8gent${version ? ` v${version}` : ""}`;
	const full = branch ? `${head}  ⎇ ${branch}` : head;
	return cellWidth(full) <= width ? full : head;
}

export function KeysUpTitleRow(props: KeysUpTitleRowProps) {
	const { tabs, approvalPending, width } = props;
	const chip = approvalPending ? cellWidth(ASK) + 1 : 0;
	const room = Math.max(8, width - chip);
	return (
		<Box width="100%" flexShrink={0} overflow="hidden">
			<Box flexGrow={1} flexShrink={1} minWidth={0}>
				{tabs.length > 1 ? (
					<TabBar
						tabs={tabs}
						onSwitch={props.onSwitch}
						isTabProcessing={props.isTabProcessing}
						lampFor={props.lampFor}
						permFor={props.permFor}
						animate={false}
						width={room}
						line
					/>
				) : (
					<Text wrap="truncate-end" color={t.textSecondary}>
						{keysUpTitleText(props.version, props.branch, room)}
					</Text>
				)}
			</Box>
			{approvalPending ? (
				<Box flexShrink={0} marginLeft={1}>
					<Text color={t.orange} bold>
						{ASK}
					</Text>
				</Box>
			) : null}
		</Box>
	);
}
