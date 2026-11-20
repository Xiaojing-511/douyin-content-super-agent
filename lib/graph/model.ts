import "server-only";

import { ChatOpenAI } from "@langchain/openai";

import { config, missingModelSettingNames } from "@/lib/config";

/**
 * 模型一律走 OpenAI 兼容的 chat completions。
 * 地址、密钥和模型名来自环境变量，未配置时不创建客户端。
 * useResponsesApi 保持关闭，国内兼容接口只实现 /chat/completions。
 */

export function createChatModel(): ChatOpenAI {
  const missingSettings = missingModelSettingNames();
  if (missingSettings.length > 0) {
    throw new Error(`还没有配置模型：${missingSettings.join("、")}`);
  }

  return new ChatOpenAI({
    model: config.llmModel,
    apiKey: config.llmApiKey,
    streaming: true,
    maxRetries: 0,
    useResponsesApi: false,
    configuration: {
      baseURL: config.llmBaseUrl,
    },
  });
}
