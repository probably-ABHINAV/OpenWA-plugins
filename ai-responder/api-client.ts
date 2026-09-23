import type { PluginNetResponse, PluginNetRequestInit } from '../types/openwa';

export interface ChatCompletionConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
}

/**
 * Pure HTTP client for calling OpenAI-compatible Chat Completions.
 * Uses the injected fetchFn (bound to ctx.net.fetch) so it can be tested offline.
 */
export async function fetchChatCompletion(
  fetchFn: (url: string, init?: PluginNetRequestInit) => Promise<PluginNetResponse>,
  config: ChatCompletionConfig,
  userMessage: string
): Promise<string> {
  const url = config.apiBaseUrl.replace(/\/$/, '') + '/chat/completions';
  
  const messages: Array<{ role: string; content: string }> = [];
  if (config.systemPrompt && config.systemPrompt.trim()) {
    messages.push({ role: 'system', content: config.systemPrompt.trim() });
  }
  messages.push({ role: 'user', content: userMessage });

  const payload = JSON.stringify({
    model: config.model,
    messages
  });

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: payload,
    timeoutMs: 15000 // Give the LLM 15 seconds max so we don't hold the hook indefinitely
  });

  if (!response.ok) {
    throw new Error(`AI API failed with status ${response.status}: ${response.body}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(response.body);
  } catch (err) {
    throw new Error('AI API returned invalid JSON');
  }

  const replyText = parsed.choices?.[0]?.message?.content;
  if (typeof replyText !== 'string' || !replyText.trim()) {
    throw new Error('AI API returned an empty or malformed reply');
  }

  return replyText;
}
