export const DEEPSEEK_PRICE_USD_PER_MTOK = {
  inputMiss: Number(process.env.DEEPSEEK_INPUT_USD || 0.15),
  inputHit: Number(process.env.DEEPSEEK_CACHED_USD || 0.003),
  output: Number(process.env.DEEPSEEK_OUTPUT_USD || 0.6),
};

export type Usage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
};

export function usageCostUsd(usage: Usage) {
  const prompt = Number(usage.promptTokens) || 0;
  const cached = Math.min(Number(usage.cachedTokens) || 0, prompt);
  const miss = Math.max(0, prompt - cached);
  const output = Number(usage.completionTokens) || 0;
  return (
    (miss * DEEPSEEK_PRICE_USD_PER_MTOK.inputMiss +
      cached * DEEPSEEK_PRICE_USD_PER_MTOK.inputHit +
      output * DEEPSEEK_PRICE_USD_PER_MTOK.output) /
    1_000_000
  );
}

export function usdInrRate() {
  return Number(process.env.USD_INR_RATE || 800);
}

export function usdToInr(usd: number) {
  return usd * usdInrRate();
}
