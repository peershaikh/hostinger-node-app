export interface AiConfig {
  defaultProvider: string;
  gemini: {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
  };
}

export const aiConfig: AiConfig = {
  defaultProvider: process.env.AI_DEFAULT_PROVIDER || 'GEMINI',
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    timeoutMs: 10000
  }
};
