import type React from "react";
import { colors, fonts } from "../lib/tokens";
import { useTypewriter } from "../lib/animations";

interface CodeBlockProps {
  code: string;
  delay?: number;
  speed?: number;
}

/** Syntax-highlighted code block with typewriter animation */
export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  delay = 0,
  speed = 1.5,
}) => {
  const visibleCode = useTypewriter(code, delay, speed);

  // Very basic syntax highlighting
  const highlighted = visibleCode
    .replace(
      /(\/\/.*)/g,
      `<span style="color:${colors.textMuted}">$1</span>`
    )
    .replace(
      /\b(const|let|import|from|export|async|await|function|return)\b/g,
      `<span style="color:${colors.accent}">$1</span>`
    )
    .replace(
      /(".*?"|'.*?'|`.*?`)/g,
      `<span style="color:${colors.success}">$1</span>`
    )
    .replace(
      /\b(\d+)\b/g,
      `<span style="color:${colors.warning}">$1</span>`
    );

  return (
    <pre
      style={{
        fontFamily: fonts.mono,
        fontSize: 16,
        lineHeight: 1.6,
        color: colors.text,
        margin: 0,
        whiteSpace: "pre-wrap",
      }}
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
};
