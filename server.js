import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/idoma-match", async (req, res) => {
  console.log("POST /api/idoma-match received:", req.body?.transcript);
  try {
    const { transcript, candidates } = req.body || {};
    if (!transcript || !Array.isArray(candidates) || candidates.length === 0) {
      return res.json({ matches: [] });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ matches: [], error: "GEMINI_API_KEY missing" });
    }

    const prompt = `You are a clinical Idoma language phonetic matcher.
An automatic speech recognizer heard an Idoma speaker say: "${transcript}"
ASR output often drops initial vowels/prefixes (e.g., "wangabo" for "Unwanga bo"), merges/splits spaces, or doubles letters (e.g., "ikkpei" for "ikpeyi").

Pick up to 3 best matching entries from this verified glossary JSON. Return ONLY valid JSON:
{"matches":[{"id":"...","confidence":85}]}
If nothing plausibly matches phonetically, return {"matches":[]}.

Glossary:
${JSON.stringify(candidates)}`;

    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        })
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return res.status(502).json({ matches: [], error: `Gemini API error (${apiRes.status}): ${errText}` });
    }

    const data = await apiRes.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"matches":[]}';
    const parsed = JSON.parse(rawText);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
    console.log("POST /api/idoma-match returned:", matches.length, "matches");
    return res.json({ matches });
  } catch (err) {
    console.error("POST /api/idoma-match error:", err);
    return res.status(500).json({ matches: [], error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Idoma matcher API listening on ${port}`));
