import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Built-in Idoma phonetic fallback when Gemini API is temporarily 503
function normalizePhonetic(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ou]/g, "u")
    .replace(/[ei]/g, "i")
    .replace(/kp/g, "p")
    .replace(/gb/g, "b")
    .replace(/nw|ny/g, "n")
    .replace(/(.)\1+/g, "$1")
    .replace(/[^a-z]/g, "");
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function localPhoneticFallback(transcript, candidates) {
  const normT = normalizePhonetic(transcript);
  if (normT.length < 2) return [];

  const scored = [];
  for (const c of candidates) {
    const forms = [c.idoma, c.alala, c.phonetic].filter(Boolean);
    let bestSim = 0;
    for (const f of forms) {
      const normF = normalizePhonetic(f);
      if (!normF) continue;
      const maxLen = Math.max(normT.length, normF.length);
      const dist = editDistance(normT, normF);
      const sim = 1 - dist / maxLen;
      if (sim > bestSim) bestSim = sim;
    }
    if (bestSim >= 0.55) {
      scored.push({
        id: String(c.id),
        confidence: Math.min(88, Math.max(55, Math.round(bestSim * 100)))
      });
    }
  }
  return scored.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

async function callGeminiModels(apiKey, prompt) {
  const models = ["gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-2.0-flash"];
  let lastStatus = 503;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        })
      });
      if (res.ok) {
        return { ok: true, model, res };
      }
      lastStatus = res.status;
      console.warn(`${model} returned HTTP ${res.status} (attempt ${attempt + 1})`);
      if (res.status === 404) break; // Model unavailable, immediately try next model
      if (attempt === 0) await sleep(1000);
    }
  }
  return { ok: false, status: lastStatus };
}

app.post("/api/idoma-match", async (req, res) => {
  console.log("POST /api/idoma-match received:", req.body?.transcript);
  try {
    const { transcript, candidates } = req.body || {};
    if (!transcript || !Array.isArray(candidates) || candidates.length === 0) {
      return res.json({ matches: [] });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const fallback = localPhoneticFallback(transcript, candidates);
      return res.json({ matches: fallback, source: "local-phonetic" });
    }

    const prompt = `You are a clinical Idoma language phonetic matcher.
An automatic speech recognizer heard an Idoma speaker say: "${transcript}"

ASR models transcribe Idoma phonetically and may output non-Latin scripts or distortions:
1. Vowel shifts: o <-> u, e <-> i, a <-> e (e.g. "udi ya gam" is "Ode ya gam", "ipu" vs "epu").
2. Dropped initial vowels/prefixes (e.g. "wangabo" for "Unwanga bo").
3. Merged or split word boundaries (e.g. "odiyagam" or "udi ya gam" for "Ode ya gam").
4. Doubled, dropped, or diacritic-shifted letters (e.g. "ikkpei" for "ikpeyi", "ikpẹ ikwo").

Pick up to 3 best matching entries from the verified glossary JSON below by comparing syllable rhythm, consonant skeleton, and vowel similarity (confidence 55-95).
Return ONLY valid JSON:
{"matches":[{"id":"exact_id_from_glossary","confidence":80}]}
If nothing plausibly matches phonetically, return {"matches":[]}.

Glossary:
${JSON.stringify(candidates)}`;

    const result = await callGeminiModels(apiKey, prompt);
    if (!result.ok) {
      console.warn(`All Gemini models busy (${result.status}); using Render phonetic fallback.`);
      const fallback = localPhoneticFallback(transcript, candidates);
      console.log("Fallback matches returned:", fallback.length);
      return res.json({ matches: fallback, source: "local-phonetic" });
    }

    const data = await result.res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"matches":[]}';
    console.log(`Gemini (${result.model}) raw output:`, rawText);

    const parsed = JSON.parse(rawText);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
    return res.json({ matches, source: result.model });
  } catch (err) {
    console.error("POST /api/idoma-match error:", err);
    return res.status(500).json({ matches: [], error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Idoma matcher API listening on ${port}`));
