/**
 * BottomBar — single-render wrapper for the redesigned bottom stack:
 * DjDeck, AgentInstrumentStrip, ModeFooter.
 *
 * Exists so app.tsx renders one component (`<BottomBar {...} />`)
 * instead of ~90 lines of JSX. That keeps merge conflicts in app.tsx
 * from silently clobbering the redesign — when another agent edits
 * the JSX block, the diff shows the regression instead of hiding it
 * in unrelated reformatting.
 */

import { Box } from "ink";
import React from "react";
import { AgentInstrumentStrip } from "./AgentInstrumentStrip.js";
import { DjDeck } from "./DjDeck.js";
import { ModeFooter, type FooterMode } from "./ModeFooter.js";

interface BottomBarProps {
	model: string;
	ready: number;
	total: number;
	tokens: string;
	branch: string;
	agent: string;
	micOn: boolean;
	permissions: string;
	sessionTime: string;
	mode: FooterMode;
}

export function BottomBar(props: BottomBarProps) {
	return (
		<Box flexDirection="column" width="100%" flexShrink={0}>
			<DjDeck />
			<AgentInstrumentStrip
				model={props.model}
				ready={props.ready}
				total={props.total}
				tokens={props.tokens}
				branch={props.branch}
				agent={props.agent}
				micOn={props.micOn}
				permissions={props.permissions}
				sessionTime={props.sessionTime}
			/>
			<ModeFooter active={props.mode} />
		</Box>
	);
}
