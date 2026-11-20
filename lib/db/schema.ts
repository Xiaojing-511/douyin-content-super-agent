import { bigint, index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * 当前由 Drizzle 查询的业务表只有消息表。
 * knowledge_chunks 用 pgvector 的距离运算符查询，由灌库命令建表，不放在这里。
 *
 * 消息表是这一个固定会话里的历史。
 *
 * 不建会话列表。thread_id 仍然保留，因为每一行都要标明自己属于哪一段对话；
 * 现阶段所有行都写入同一个 fixed thread id。
 * 同一轮的用户消息和助手消息在一个事务里插入。排序以自增 id 为准。
 */
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    threadId: varchar("thread_id", { length: 64 }).notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ix_conversation_messages_thread_id_id").on(table.threadId, table.id)],
);
