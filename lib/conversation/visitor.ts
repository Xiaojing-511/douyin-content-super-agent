import "server-only";

import { randomBytes } from "node:crypto";

/**
 * 每个浏览器一张票，值就是这一段对话的 thread_id。
 * 页面不上传、也不读这个值。历史、停止和 PDF 都从请求的 Cookie 里取。
 * 只有打开历史和发送会签发新票。停止和下载没有合法票时直接拒绝。
 * Secure 跟着这次请求是不是 HTTPS。当前部署是明文 HTTP，无条件加 Secure 会让浏览器丢掉票。
 */

export const VISITOR_COOKIE = "advisor_sid";

const VISITOR_ID = /^[a-f0-9]{32}$/;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface VisitorSession {
  threadId: string;
  setCookie: string | null;
}

export function isVisitorId(value: string): boolean {
  return VISITOR_ID.test(value);
}

/** 没有合法票时返回 null，不签发。 */
export function readVisitorId(request: Request): string | null {
  const existing = readCookie(request, VISITOR_COOKIE);
  if (existing && isVisitorId(existing)) {
    return existing;
  }
  return null;
}

/** 沿用已有票。没有时生成一张，调用方把它写进响应。 */
export function openVisitor(request: Request): VisitorSession {
  const existing = readVisitorId(request);
  if (existing) {
    return { threadId: existing, setCookie: null };
  }
  const threadId = randomBytes(16).toString("hex");
  return { threadId, setCookie: serializeVisitorCookie(threadId, requestIsHttps(request)) };
}

export function withVisitorCookie(response: Response, visitor: VisitorSession): Response {
  if (visitor.setCookie) {
    response.headers.append("Set-Cookie", visitor.setCookie);
  }
  return response;
}

function serializeVisitorCookie(threadId: string, secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${VISITOR_COOKIE}=${threadId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ONE_YEAR_SECONDS}${securePart}`;
}

function requestIsHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() === "https";
  }
  return new URL(request.url).protocol === "https:";
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1 || trimmed.slice(0, separator) !== name) {
      continue;
    }
    try {
      return decodeURIComponent(trimmed.slice(separator + 1));
    } catch {
      return null;
    }
  }
  return null;
}
