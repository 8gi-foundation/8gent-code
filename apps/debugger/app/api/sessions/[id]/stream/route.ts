import { NextRequest } from "next/server";
import { stat, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { watch } from "fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SESSIONS_DIR = join(homedir(), ".8gent", "sessions");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const filePath = join(SESSIONS_DIR, `${sessionId}.jsonl`);

  console.log(`[Stream API] Request for session: ${sessionId}`);
  console.log(`[Stream API] Looking for file: ${filePath}`);

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    console.error(`[Stream API] File not found: ${filePath}`);
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[Stream API] File found, size=${fileStat.size} bytes`);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Send full file first
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        let sentLines = lines.length;

        console.log(`[Stream API] Read ${lines.length} lines, sending initial batch...`);

        for (let i = 0; i < lines.length; i++) {
          const chunk = `data: ${lines[i]}\n\n`;
          console.log(`[Stream API] Enqueueing line ${i}, length=${chunk.length}, type=${JSON.parse(lines[i]).type}`);
          controller.enqueue(encoder.encode(chunk));
        }

        // Marker so client knows initial load is done
        const marker = `data: ${JSON.stringify({ type: "__initial_load_complete__", lineCount: sentLines })}\n\n`;
        console.log(`[Stream API] Sending initial_load_complete marker`);
        controller.enqueue(encoder.encode(marker));

        console.log(`[Stream API] Initial batch sent, setting up file watcher...`);

        // Watch for new lines (live tailing)
        const watcher = watch(filePath, async (eventType) => {
          console.log(`[Stream API] File watcher fired: eventType=${eventType}`);
          try {
            const newContent = await readFile(filePath, "utf-8");
            const newLines = newContent.split("\n").filter(Boolean);

            if (newLines.length > sentLines) {
              const added = newLines.slice(sentLines);
              console.log(`[Stream API] ${added.length} new lines detected (${sentLines} -> ${newLines.length})`);
              for (const line of added) {
                controller.enqueue(encoder.encode(`data: ${line}\n\n`));
              }
              sentLines = newLines.length;
            } else {
              console.log(`[Stream API] No new lines (still ${sentLines})`);
            }
          } catch (err) {
            console.error(`[Stream API] File watcher read error:`, err);
          }
        });

        console.log(`[Stream API] File watcher active for ${filePath}`);

        request.signal.addEventListener("abort", () => {
          console.log(`[Stream API] Client disconnected for ${sessionId}`);
          watcher.close();
          controller.close();
        });
      } catch (error) {
        console.error(`[Stream API] Error in stream start:`, error);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "__error__", message: String(error) })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  console.log(`[Stream API] Returning SSE response for ${sessionId}`);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
