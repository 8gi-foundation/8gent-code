/**
 * 8gent Code - Questions View
 *
 * Questions to research later. Add questions, add answers.
 * Shows [?] for unanswered, [A] for answered with answer indented below.
 * Data persists to ~/.8gent/tabs/questions.json
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider } from "../components/primitives/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.env.HOME || "~", ".8gent", "tabs");

interface QuestionEntry {
  id: string;
  question: string;
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

interface QuestionsData {
  questions: QuestionEntry[];
}

function loadQuestions(): QuestionEntry[] {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const filepath = join(DATA_DIR, "questions.json");
    if (existsSync(filepath)) {
      const raw = JSON.parse(readFileSync(filepath, "utf-8")) as QuestionsData;
      return raw.questions || [];
    }
  } catch {}
  return [];
}

function saveQuestions(questions: QuestionEntry[]): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "questions.json"), JSON.stringify({ questions }, null, 2));
  } catch {}
}

type Mode = "list" | "add" | "answer";

interface QuestionsViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

export function QuestionsView({ visible, data, onUpdateData, onClose }: QuestionsViewProps) {
  const [questions, setQuestions] = useState<QuestionEntry[]>(() => {
    const fromFile = loadQuestions();
    if (fromFile.length > 0) return fromFile;
    const fromProps = data.questions as QuestionEntry[] | undefined;
    return fromProps || [];
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [inputBuffer, setInputBuffer] = useState("");

  const updateQuestions = useCallback((updated: QuestionEntry[]) => {
    setQuestions(updated);
    saveQuestions(updated);
    onUpdateData({ questions: updated });
  }, [onUpdateData]);

  const unanswered = questions.filter((q) => !q.answer);
  const answered = questions.filter((q) => q.answer);

  // Clamp selectedIndex
  useEffect(() => {
    if (selectedIndex >= questions.length && questions.length > 0) {
      setSelectedIndex(questions.length - 1);
    }
    if (questions.length === 0) setSelectedIndex(0);
  }, [questions.length, selectedIndex]);

  useInput((input, key) => {
    if (!visible) return;

    // --- ADD question mode ---
    if (mode === "add") {
      if (key.return) {
        if (inputBuffer.trim()) {
          const newQ: QuestionEntry = {
            id: `q-${Date.now()}`,
            question: inputBuffer.trim(),
            createdAt: new Date().toISOString(),
          };
          const updated = [...questions, newQ];
          updateQuestions(updated);
          setSelectedIndex(updated.length - 1);
        }
        setInputBuffer("");
        setMode("list");
        return;
      }
      if (key.escape) {
        setInputBuffer("");
        setMode("list");
        return;
      }
      if (key.backspace || key.delete) {
        setInputBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInputBuffer((prev) => prev + input);
        return;
      }
      return;
    }

    // --- ANSWER mode ---
    if (mode === "answer") {
      if (key.return) {
        if (inputBuffer.trim() && questions[selectedIndex]) {
          const now = new Date().toISOString();
          const updated = questions.map((q, i) =>
            i === selectedIndex
              ? { ...q, answer: inputBuffer.trim(), answeredAt: now }
              : q
          );
          updateQuestions(updated);
        }
        setInputBuffer("");
        setMode("list");
        return;
      }
      if (key.escape) {
        setInputBuffer("");
        setMode("list");
        return;
      }
      if (key.backspace || key.delete) {
        setInputBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInputBuffer((prev) => prev + input);
        return;
      }
      return;
    }

    // --- LIST mode ---
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(questions.length - 1, prev + 1));
    } else if (input === "a" || input === "n") {
      setInputBuffer("");
      setMode("add");
    } else if (input === "r" && questions.length > 0) {
      // Answer mode - works on any question (can re-answer too)
      setInputBuffer("");
      setMode("answer");
    } else if (input === "d" && questions.length > 0) {
      const updated = questions.filter((_, i) => i !== selectedIndex);
      updateQuestions(updated);
    } else if (key.escape || input === "q") {
      onClose();
    }
  }, { isActive: visible });

  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Heading>Questions</Heading>
        <MutedText>
          {"  "}Research later — {unanswered.length} open, {answered.length} answered
        </MutedText>
      </Box>

      <Divider />

      {mode === "add" && (
        <Box marginY={1}>
          <Text color="cyan" bold>{"?: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
      )}

      {mode === "answer" && questions[selectedIndex] && (
        <Box marginY={1} flexDirection="column">
          <MutedText>Answering: {questions[selectedIndex].question}</MutedText>
          <Box>
            <Text color="green" bold>{"A: "}</Text>
            <AppText>{inputBuffer}</AppText>
            <Text color="cyan">_</Text>
          </Box>
        </Box>
      )}

      {questions.length === 0 && mode === "list" ? (
        <Box paddingY={1}>
          <MutedText>No questions yet. Press [a] to add one.</MutedText>
        </Box>
      ) : (
        <Stack>
          {questions.map((q, i) => (
            <Box key={q.id} flexDirection="column">
              <Box>
                <Text color={i === selectedIndex ? "cyan" : undefined}>
                  {i === selectedIndex ? ">" : " "}{" "}
                </Text>
                <Text color={q.answer ? "green" : "yellow"}>
                  {q.answer ? "[A]" : "[?]"}{" "}
                </Text>
                <AppText bold={i === selectedIndex}>{q.question}</AppText>
                <Box flexGrow={1} />
                <MutedText>
                  {q.answeredAt
                    ? `answered ${new Date(q.answeredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                    : new Date(q.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </MutedText>
              </Box>
              {q.answer && (
                <Box marginLeft={5}>
                  <Text color="green" dimColor>{"-> "}</Text>
                  <Text color="green">{q.answer}</Text>
                </Box>
              )}
            </Box>
          ))}
        </Stack>
      )}

      <Box marginTop={1}>
        <Divider />
      </Box>
      <MutedText>
        a=add question  r=answer selected  d=delete  arrows=navigate  ESC=back
      </MutedText>
    </Box>
  );
}
