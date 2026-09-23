import type { IPlugin, PluginContext, HookContext, IncomingMessage } from '../types/openwa';
import { fetchChatCompletion, type ChatCompletionConfig } from './api-client.ts';

declare const __PLUGIN_VERSION__: string;
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : '0.0.0-dev';

export function parseConfig(raw: Record<string, unknown>): ChatCompletionConfig & { maxReplies: number } {
  const apiBaseUrl = String(raw.apiBaseUrl ?? 'https://api.openai.com/v1');
  const apiKey = String(raw.apiKey ?? '');
  const model = String(raw.model ?? 'gpt-4o-mini');
  
  if (!apiBaseUrl) throw new Error('ai-responder: apiBaseUrl is required');
  if (!apiKey) throw new Error('ai-responder: apiKey is required');
  if (!model) throw new Error('ai-responder: model is required');
  
  const systemPrompt = typeof raw.systemPrompt === 'string' ? raw.systemPrompt : undefined;
  
  const rawMax = Number(raw.maxRepliesPerChatPerHour);
  const maxReplies = Number.isFinite(rawMax) && rawMax >= 1 ? rawMax : 20;

  return { apiBaseUrl, apiKey, model, systemPrompt, maxReplies };
}

export default class AIResponder implements IPlugin {
  private ctx: PluginContext | null = null;
  private config: ReturnType<typeof parseConfig> | null = null;
  
  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.config = parseConfig(ctx.config);
    
    ctx.registerHook('message:received', this.onMessage.bind(this));
    
    ctx.logger.log(`ai-responder v${PLUGIN_VERSION} enabled with model ${this.config.model}`);
  }
  
  async onConfigChange(ctx: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    this.ctx = ctx;
    this.config = parseConfig(newConfig);
    ctx.logger.log(`ai-responder config updated, using model ${this.config.model}`);
  }
  
  async healthCheck() {
    return { healthy: this.config !== null, message: `v${PLUGIN_VERSION}` };
  }
  
  private async onMessage(hook: HookContext): Promise<{ continue: boolean }> {
    if (!this.ctx || !this.config) return { continue: true };
    
    const msg = hook.data as IncomingMessage;
    
    // Ignore own messages
    if (msg.fromMe) return { continue: true };
    // Require text to process
    if (!msg.body || !msg.body.trim()) return { continue: true };
    
    // Ignore non-user-interactive types like unknown/revoked/system messages if they lack a clear text intent
    // But since body is populated, we can allow text/image/video/document/audio etc.
    // If it's a call or masked, it won't have body anyway.
    
    const chatId = msg.chatId;
    if (!chatId) return { continue: true };
    const sessionId = hook.sessionId || 'default';
    
    // Rate limit check
    if (!(await this.checkRateLimit(sessionId, chatId))) {
      this.ctx.logger.warn(`ai-responder: rate limit exceeded for chat ${chatId}`);
      return { continue: true };
    }
    
    try {
      const replyText = await fetchChatCompletion(
        this.ctx.net.fetch.bind(this.ctx.net),
        this.config,
        msg.body.trim()
      );
      
      // Send quote-reply
      await this.ctx.messages.reply(sessionId, chatId, msg.id, replyText);
      
      // We answered, but let other plugins also process the message if they want.
      return { continue: true };
    } catch (err) {
      this.ctx.logger.error(`ai-responder: failed to generate or send reply for ${msg.id}`, err);
      return { continue: true }; // Fail closed
    }
  }
  
  private async checkRateLimit(sessionId: string, chatId: string): Promise<boolean> {
    if (!this.ctx || !this.config) return false;
    
    const now = Date.now();
    const currentHour = Math.floor(now / 3600000);
    const key = `ratelimit:${sessionId}:${chatId}:${currentHour}`;
    
    try {
      const current = await this.ctx.storage.get<number>(key) || 0;
      if (current >= this.config.maxReplies) {
        return false;
      }
      await this.ctx.storage.set(key, current + 1);
      return true;
    } catch (err) {
      this.ctx.logger.error(`ai-responder: rate limit check failed for ${chatId}`, err);
      // fail closed to prevent abuse on storage errors
      return false; 
    }
  }
}
