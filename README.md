# 关系认知顾问

给亲密关系认知类短视频创作者用的单会话口播顾问。使用者抛出一个日常相处反应，顾问把它收成一段从容、具体、像本人会说的话：一个画面、一个机制、一个例子、一小步，并带上一句边界。页面标题是「关系认知顾问」。

当前仓库是这条链路的可运行版本：固定一个会话、流式回复、Postgres 持久化，以及对话前的知识库检索。多会话、主机制卡片、写前确认、稿件导出还没有做。

## 现在能做什么

- 打开页面即可续写同一个会话。刷新后历史来自数据库，不靠浏览器本地缓存。
- 回复按字流式出现。生成中可以停止；已经显示出来的半截回复会写入数据库，一个字都还没出来就停的，这一轮不落库。
- 主模型走 OpenAI 兼容的 Chat Completions。对话、嵌入、重排可以指向不同服务。
- 发送前先检索 `rag/` 里的资料。按标题切分，向量存在同一套 Postgres 的 pgvector 里。配齐重排后，先召回 6 段，再留下 3 段放进这一轮提示。
- 没配嵌入模型，或知识库还是空的，对话仍然可用，只是这一轮没有资料。
- 系统提示限制在五个相处机制里，并拒绝诊疗、操控话术、关系去留等请求。约束写在提示词里，还没有独立的生成后护栏。

## 技术栈

### 应用

| 层 | 选择 |
| --- | --- |
| 界面与接口 | Next.js 16 App Router、React 19、TypeScript |
| 对话历史 | Drizzle ORM + `postgres`，表 `conversation_messages` |
| 数据库 | Docker 里的 `pgvector/pgvector:pg16`。消息、checkpoint、向量片段在同一个库 |
| 流式协议 | `POST` 的 SSE。页面用 `fetch` 读响应体，因为 `EventSource` 不能发 POST |

### AI

| 层 | 选择 | 代码 |
| --- | --- | --- |
| 编排 | LangGraph.js。图是 `retrieve → reply`，状态整表替换，不把半截回复累进下一轮 | `lib/graph/advisor.ts` |
| 对话模型 | `@langchain/openai` 的 `ChatOpenAI`，关闭 Responses API，只走 `/chat/completions` | `lib/graph/model.ts` |
| 检查点 | `@langchain/langgraph-checkpoint-postgres` 的 `PostgresSaver`。供后续人审恢复，页面不读它 | `lib/graph/checkpoint.ts` |
| 系统提示 | 每次回复重读 Markdown，去掉文首 HTML 注释后再发给模型 | `prompt/advisor-system.md` |
| 切分 | `#`–`###` 为界。短导语不成块，超过 800 字才按段重叠切开。来源节不参与检索 | `lib/knowledge/chunk-markdown.ts` |
| 入库 | 内容哈希 + 嵌入模型名。没变的片段不重复请求嵌入，失败不覆盖旧表 | `lib/knowledge/index-library.ts` |
| 召回 | 问句单独嵌入，pgvector 余弦距离 `<=>`，HNSW 索引 | `lib/knowledge/search.ts` |
| 重排 | 可选。请求 `{RERANK_BASE_URL}/rerank`，形态与 Cohere、SiliconFlow 相同 | `lib/knowledge/rerank.ts` |

两套存储各管一件事：`conversation_messages` 是用户看到的历史；LangGraph checkpoint 是图自己的状态。召回片段只拼进这一轮系统提示，不写进消息表，也不会变成一条聊天记录。

## 一次发送怎么走

```text
输入框
  -> POST /api/chat/runs
  -> 用已落库历史覆盖图状态
  -> retrieve：嵌入本轮问句，余弦召回，可选重排
  -> reply：系统提示 + 资料 + 历史，ChatOpenAI 流式输出
  -> SSE  message.delta / trace / done / error
  -> 整轮成功，或停止时已经有可见文字，才写入 conversation_messages
```

`trace` 只打到浏览器控制台，不展示、不入库。`thread_id` 只在服务端，默认 `single-advisor-session`。

## 从哪里读代码

| 想看什么 | 从这里进 |
| --- | --- |
| 页面与停止按钮 | `components/ChatApp.tsx`、`components/useSingleConversation.ts` |
| SSE 编解码 | `lib/conversation/sse.ts`、`components/conversationClient.ts` |
| 发送、落库、中止 | `app/api/chat/runs/route.ts`、`app/api/chat/runs/stop/route.ts` |
| 图和检索节点 | `lib/graph/advisor.ts` |
| 切分、灌库、查询 | `lib/knowledge/`、`scripts/index-knowledge.ts` |
| 资料正文 | `rag/` |
| 顾问人设与拒绝范围 | `prompt/advisor-system.md` |
| 环境变量 | `.env.example`、`lib/config.ts` |

## 本地运行

需要 Node.js 20+、Docker，以及一个 OpenAI 兼容的对话接口。嵌入和重排可以后补。

```bash
docker compose up -d
cp .env.example .env
npm install
npm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。数据库健康检查是 [http://localhost:3000/api/health](http://localhost:3000/api/health)。

`.env` 里至少填这三项，改完后重启 `npm run dev`：

```bash
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=
LLM_MODEL=deepseek-flash
```

`LLM_BASE_URL` 填厂商的兼容根路径。DeepSeek 用 `https://api.deepseek.com`，不要再加 `/v1`。密钥只放在 `.env`，示例文件留空。

要让回答带上资料，再填嵌入配置并灌库：

```bash
EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
EMBEDDING_DIMENSIONS=1024

npm run index-knowledge
```

默认维度 1024，对应 bge-m3 这一类模型。`rag/` 改完后要再执行一次灌库，聊天请求不会重读磁盘上的 Markdown。没改过的片段不会再次请求嵌入。换维度需要先删掉 `knowledge_chunks` 再灌库。

重排是可选项。三项都留空时，按向量距离取前 6 段；三项都填上后，重排并留下 3 段。只填一部分会直接失败。换重排模型不用重新灌库。

```bash
RERANK_BASE_URL=
RERANK_API_KEY=
RERANK_MODEL=
```

Postgres 用户、密码、库名都是 `advisor`，端口 `5432`。本机如果另有 PostgreSQL 占着 `127.0.0.1:5432`，连接会进到没有 pgvector 的那一份，灌库会报 `extension "vector" is not available`。先停掉本机实例，让 Docker 单独占用这个端口。

## 当前边界

这一版故意保持单会话、单主模型。下面这些还没有接到页面或图上：主机制判定、写前的人工确认、按机制过滤的方法卡、生成后内容护栏、Markdown / PDF 导出、风格档案、长对话滚动摘要、对外工具调用。系统提示里的拒绝范围因此还不是硬拦截。
