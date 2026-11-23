import { bigint, index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

import type { ProcessStep } from "@/lib/conversation/types";

/**
 * 当前由 Drizzle 查询的业务表只有消息表。
 * knowledge_chunks 用 pgvector 的距离运算符查询，由灌库命令建表，不放在这里。
 *
 * 消息表按浏览器票上的 thread_id 分开。每个浏览器一段对话，不建会话列表。
 * 同一轮的用户消息和助手消息在一个事务里插入。排序以自增 id 为准。
 * process 只出现在助手行，给页面画过程条。下一轮提示不读这一列。
 */
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    threadId: varchar("thread_id", { length: 64 }).notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    process: jsonb("process").$type<ProcessStep[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ix_conversation_messages_thread_id_id").on(table.threadId, table.id)],
);
