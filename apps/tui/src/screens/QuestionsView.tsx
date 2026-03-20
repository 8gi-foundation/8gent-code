/**
 * 8gent Code - Questions View
 *
 * Questions to research later. Add, answer, delete.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Stack, Divider } from "../components/primitives/index.js";

interface QuestionEntry {
  id: string;
  question: string;
  answer: string | null;
  createdAt: string;
}

interface QuestionsViewProps {
  visible: boolean;
  data: Record<string, unknown>;
  onUpdateData: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

export function QuestionsView({ visible, data, onUpdateData, onClose }: QuestionsViewProps) {
  const questions: QuestionEntry[] = (data.questions as QuestionEntry[]) || [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputMode, setInputMode] = useState<"question" | "answer" | null>(null);
  const [inputBuffer, setInputBuffer] = useState("");

  const unanswered = questions.filter((q) => !q.answer);
  const answered = questions.filter((q) => q.answer);

  useInput((input, key) => {
    if (!visible) return;

    if (inputMode) {
      if (key.return) {
        if (inputMode === "question" && inputBuffer.trim()) {
          const newQ: QuestionEntry = {
            id: `q-${Date.now()}`,
            question: inputBuffer.trim(),
            answer: null,
            createdAt: new Date().toISOString(),
          };
          const updated = [...questions, newQ];
          onUpdateData({ questions: updated });
          setSelectedIndex(updated.length - 1);
        } else if (inputMode === "answer" && inputBuffer.trim() && questions.length > 0) {
          const updated = questions.map((q, i) =>
            i === selectedIndex ? { ...q, answer: inputBuffer.trim() } : q
          );
          onUpdateData({ questions: updated });
        }
        setInputBuffer("");
        setInputMode(null);
        return;
      }
      if (key.escape) {
        setInputBuffer("");
        setInputMode(null);
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

    // Normal mode
    if (key.upArrow) setSelectedIndex((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setSelectedIndex((prev) => Math.min(questions.length - 1, prev + 1));
    if (input === "a" || input === "n") {
      setInputMode("question");
      setInputBuffer("");
    }
    if (input === "r" && questions.length > 0 && !questions[selectedIndex]?.answer) {
      setInputMode("answer");
      setInputBuffer("");
    }
    if ((input === "d" || key.delete) && questions.length > 0) {
      const updated = questions.filter((_, i) => i !== selectedIndex);
      onUpdateData({ questions: updated });
      setSelectedIndex(Math.min(selectedIndex, Math.max(0, updated.length - 1)));
    }
    if (key.escape || input === "q") {
      onClose();
    }
  });

  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Heading>Questions</Heading>
        <MutedText>  Research later — {unanswered.length} open, {answered.length} answered</MutedText>
      </Box>

      <Divider />

      {inputMode === "question" && (
        <Box marginY={1}>
          <Text color="cyan" bold>{"?: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
      )}

      {inputMode === "answer" && (
        <Box marginY={1}>
          <Text color="green" bold>{"A: "}</Text>
          <AppText>{inputBuffer}</AppText>
          <Text color="cyan">_</Text>
        </Box>
      )}

      {questions.length === 0 && !inputMode ? (
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
              </Box>
              {q.answer && (
                <Box marginLeft={5}>
                  <MutedText>{"-> "}</MutedText>
                  <AppText color="green">{q.answer}</AppText>
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
