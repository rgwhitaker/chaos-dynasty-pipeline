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

/** The vision model used for screenshot/frame analysis. */
export function visionModel(): string {
  return process.env.XAI_MODEL_VISION ?? "grok-2-vision-latest";
}

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
    throw new Error(
      `Grok API error (${response.status} ${response.statusText}): ${errorBody}`,
    );
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Grok API response did not include completion content.");
  }

  return content;
}

export async function generateNarrative(prompt: string, systemPrompt?: string) {
  const messages: GrokMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: prompt });

  const textModel = process.env.XAI_MODEL_TEXT ?? "grok-3-latest";
  return requestGrok(textModel, messages);
}

export async function analyzeScreenshot(imageUrl: string, prompt: string) {
  return requestGrok(visionModel(), [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ]);
}

/**
 * Analyze several images together with a single prompt using the Grok vision
 * model. Used by the video pipeline to send a handful of extracted frames so the
 * model can reconcile a box score across multiple stills. `imageUrls` may be
 * public URLs or base64 `data:` URLs.
 */
export async function analyzeImages(
  imageUrls: string[],
  prompt: string,
  systemPrompt?: string,
) {
  if (imageUrls.length === 0) {
    throw new Error("analyzeImages requires at least one image.");
  }

  const visionModelName = visionModel();

  const messages: GrokMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({
    role: "user",
    content: [
      { type: "text", text: prompt },
      ...imageUrls.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ],
  });

  return requestGrok(visionModelName, messages);
}
