import "server-only";

import { asc, eq } from "drizzle-orm";

import { config } from "@/lib/config";
import { getDatabase } from "@/lib/db/client";
import { conversationMessages } from "@/lib/db/schema";
import { logInfo, previewText } from "@/lib/logging";
import type { ConversationMessage, ConversationRole } from "@/lib/conversation/types";

/**
 * 把一轮里的用户原文和助手正文放进同一个事务。
 * 助手正文可以是模型写完的全文，也可以是中止时页面上已经出现的半截。
 * 一个字都还没有推到页面上就中止的，不要调用。那样不会留下只有用户消息的半轮。
 */

const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";

export async function listMessages(): Promise<ConversationMessage[]> {
  const database = getDatabase();
  const records = await database
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.threadId, config.fixedThreadId))
    .orderBy(asc(conversationMessages.id));

  logInfo("数据库已返回历史消息", {
    会话: config.fixedThreadId,
    条数: records.length,
  });

  return records.map((record) => ({
    id: record.id,
    role: conversationRole(record.role),
    content: record.content,
    createdAt: record.createdAt.toISOString(),
  }));
}

export async function appendCompletedTurn(userText: string, assistantText: string): Promise<void> {
  if (!userText || !assistantText) {
    throw new Error("完成的一轮必须同时包含用户原文和助手全文");
  }

  const database = getDatabase();
  await database.transaction(async (transaction) => {
    await transaction.insert(conversationMessages).values([
      { threadId: config.fixedThreadId, role: USER_ROLE, content: userText },
      { threadId: config.fixedThreadId, role: ASSISTANT_ROLE, content: assistantText },
    ]);
  });

  logInfo("数据库已写入本轮对话", {
    会话: config.fixedThreadId,
    用户预览: previewText(userText),
    回复字数: Array.from(assistantText).length,
  });
}

function conversationRole(role: string): ConversationRole {
  if (role === USER_ROLE || role === ASSISTANT_ROLE) {
    return role;
  }
  throw new Error(`未知的消息角色: ${role}`);
}
