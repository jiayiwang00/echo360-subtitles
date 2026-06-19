const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "DEEPSEEK_TRANSLATE_BATCH") return false;

  translateBatchWithDeepSeek(message)
    .then(translations => sendResponse({ ok: true, translations }))
    .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

function parseTranslationBatch(content, expectedLength) {
  const normalized = String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error("DeepSeek returned invalid JSON for the translation batch");
  }

  const items = Array.isArray(parsed) ? parsed : parsed?.translations;
  if (!Array.isArray(items) || items.length !== expectedLength) {
    throw new Error("DeepSeek returned an incomplete translation batch");
  }

  const byId = new Map(items.map(item => [Number(item?.id), String(item?.text || "").trim()]));
  return Array.from({ length: expectedLength }, (_, id) => {
    const translation = byId.get(id);
    if (!translation) throw new Error(`DeepSeek omitted translation ${id}`);
    return translation;
  });
}

async function translateBatchWithDeepSeek({ apiKey, model, targetLanguage, texts }) {
  const normalizedKey = String(apiKey || "").trim();
  const normalizedModel = String(model || "").trim();
  if (!normalizedKey) throw new Error("DeepSeek API key is required");
  if (!normalizedModel) throw new Error("DeepSeek model is required");
  if (!Array.isArray(texts) || !texts.length) throw new Error("Translation batch is empty");

  const sourceItems = texts.map((text, id) => ({ id, text: String(text || "") }));

  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${normalizedKey}`
    },
    body: JSON.stringify({
      model: normalizedModel,
      messages: [
        {
          role: "system",
          content: `Translate every subtitle into ${targetLanguage}. Preserve each id. Return only JSON in this exact shape: {"translations":[{"id":0,"text":"translated text"}]}. Do not omit, merge, explain, or reorder items.`
        },
        { role: "user", content: JSON.stringify(sourceItems) }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || response.statusText;
    throw new Error(`DeepSeek HTTP ${response.status}: ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned an empty translation batch");
  return parseTranslationBatch(content, sourceItems.length);
}
