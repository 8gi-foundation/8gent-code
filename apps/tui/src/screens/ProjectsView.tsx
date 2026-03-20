/**
 * 8gent Code - Projects View
 *
 * Project overview. Reads from .8gent/config.json or shows
 * basic project info from cwd.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider, Badge } from "../components/primitives/index.js";
import * as fs from "fs";
import * as path from "path";

interface ProjectInfo {
  name: string;
  description: string;
  path: string;
  status: "active" | "paused" | "archived";
}

interface ProjectsViewProps {
  visible: boolean;
  onClose: () => void;
}

function loadProjectInfo(): ProjectInfo[] {
  const projects: ProjectInfo[] = [];

  // Try .8gent/config.json
  const configPath = path.join(process.env.HOME || "~", ".8gent", "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (Array.isArray(config.projects)) {
        return config.projects;
      }
    }
  } catch {
    // Fall through to cwd detection
  }

  // Fallback: detect from cwd
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      projects.push({
        name: pkg.name || path.basename(cwd),
        description: pkg.description || "No description",
        path: cwd,
        status: "active",
      });
    } else {
      projects.push({
        name: path.basename(cwd),
        description: "Current directory",
        path: cwd,
        status: "active",
      });
    }
  } catch {
    projects.push({
      name: path.basename(cwd),
      description: "Current directory",
      path: cwd,
      status: "active",
    });
  }

  return projects;
}

const STATUS_COLORS: Record<string, string> = {
  active: "green",
  paused: "yellow",
  archived: "red",
};

export function ProjectsView({ visible, onClose }: ProjectsViewProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (visible) {
      setProjects(loadProjectInfo());
    }
  }, [visible]);

  useInput((input, key) => {
    if (!visible) return;
    if (key.upArrow) setSelectedIndex((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setSelectedIndex((prev) => Math.min(projects.length - 1, prev + 1));
    if (key.escape || input === "q") onClose();
  });

  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Heading>Projects</Heading>
        <MutedText>  {projects.length} project{projects.length !== 1 ? "s" : ""}</MutedText>
      </Box>

      <Divider />

      {projects.length === 0 ? (
        <Box paddingY={1}>
          <MutedText>No projects detected.</MutedText>
        </Box>
      ) : (
        <Stack>
          {projects.map((project, i) => (
            <Box key={project.path} flexDirection="column" marginBottom={i < projects.length - 1 ? 1 : 0}>
              <Box>
                <Text color={i === selectedIndex ? "cyan" : undefined}>
                  {i === selectedIndex ? ">" : " "}{" "}
                </Text>
                <AppText bold>{project.name}</AppText>
                <Box marginLeft={1}>
                  <Badge label={project.status} color={STATUS_COLORS[project.status] || "blue"} />
                </Box>
              </Box>
              <Box marginLeft={3}>
                <MutedText>{project.description}</MutedText>
              </Box>
              <Box marginLeft={3}>
                <MutedText>{project.path}</MutedText>
              </Box>
            </Box>
          ))}
        </Stack>
      )}

      <Box marginTop={1}>
        <Divider />
      </Box>
      <MutedText>
        arrows=navigate  ESC=back
      </MutedText>
    </Box>
  );
}
