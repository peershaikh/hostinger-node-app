export interface AiConfig {
  defaultProvider: string;
  gemini: {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
  };
  deepseek: {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
  };
}

export const aiConfig: AiConfig = {
  defaultProvider: process.env.AI_DEFAULT_PROVIDER || 'DEEPSEEK',
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    timeoutMs: 10000
  },
  deepseek: {
    // API key is set via Hostinger environment variable DEEPSEEK_API_KEY only.
    // Never hardcode or log this value.
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    timeoutMs: 15000
  }
};
