type GrokMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const GROK_API_URL = process.env.XAI_API_BASE_URL ?? "https://api.x.ai/v1/chat/completions";
const TEXT_MODEL = process.env.XAI_MODEL_TEXT ?? "grok-3-latest";
const VISION_MODEL = process.env.XAI_MODEL_VISION ?? "grok-2-vision-latest";

async function requestGrok(model: string, messages: GrokMessage[]) {
  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing XAI_API_KEY");
  }

  const response = await fetch(GROK_API_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Grok API error (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return data.choices?.[0]?.message?.content ?? "";
}

export async function generateNarrative(prompt: string, systemPrompt?: string) {
  const messages: GrokMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: prompt });

  return requestGrok(TEXT_MODEL, messages);
}

export async function analyzeScreenshot(imageUrl: string, prompt: string) {
  return requestGrok(VISION_MODEL, [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ]);
}
