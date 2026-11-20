/**
 * 把 fetch 读到的文本块拼回一个个 SSE 事件。
 *
 * 网络层一次 read() 可能只拿到半行，也可能一次拿到两个完整事件。
 * 因此不能按「一次 read 等于一个事件」来解析。完整事件以空行（\n\n）结束，
 * 没结束的尾巴留在 incompleteChunk，等下一块接上。
 */

export interface ParsedServerSentEvent {
  eventName: string;
  data: unknown;
}

export class ServerSentEventBuffer {
  private incompleteChunk = "";

  consume(textChunk: string): ParsedServerSentEvent[] {
    this.incompleteChunk += textChunk;
    const blocks = this.incompleteChunk.split("\n\n");
    this.incompleteChunk = blocks.pop() ?? "";
    return blocks.flatMap((block) => {
      const parsedEvent = parseEventBlock(block);
      return parsedEvent ? [parsedEvent] : [];
    });
  }
}

function parseEventBlock(block: string): ParsedServerSentEvent | null {
  const trimmedBlock = block.trim();
  if (!trimmedBlock) {
    return null;
  }

  let eventName = "message";
  const dataLines: string[] = [];
  for (const rawLine of trimmedBlock.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    eventName,
    data: JSON.parse(dataLines.join("\n")) as unknown,
  };
}
