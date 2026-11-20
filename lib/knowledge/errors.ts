/**
 * 检索失败时抛出这个错误。页面只看到固定的一句说明。
 * detail 留给本机日志，里面如果夹有密钥，调用方要先换掉。
 */

export class KnowledgeRetrievalError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("知识库检索失败");
    this.name = "KnowledgeRetrievalError";
    this.detail = detail;
  }
}
