import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

/**
 * Streaming chat route. The ONLY TokSuan-specific bits are:
 *   1. baseURL points at the TokSuan gateway, not api.openai.com
 *   2. apiKey is the TokSuan key, not the OpenAI key
 *   3. headers carries x-ts-tag for per-feature cost attribution
 *      (these tags populate the dashboard's Spend by tag card)
 *
 * Everything else is vanilla Vercel AI SDK.
 */
const tokensmart = createOpenAI({
  baseURL: process.env.TOKENSMART_BASE_URL ?? "http://localhost:8787/v1",
  apiKey: process.env.TOKENSMART_API_KEY ?? "tokensmart-dev-key",
});

export async function POST(req: Request): Promise<Response> {
  const { messages } = (await req.json()) as {
    messages: Array<{ role: string; content: string }>;
  };

  const result = await streamText({
    model: tokensmart("gpt-4o-mini"),
    messages,
    headers: {
      "x-ts-tag": "app=nextjs-chat-example,feature=chat",
    },
  });

  return result.toDataStreamResponse();
}
