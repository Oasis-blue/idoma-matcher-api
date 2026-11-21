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
      console.log("POST /api/idoma-match skipped: empty transcript or candidates");
      return res.json({ matches: [] });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("POST /api/idoma-match failed: GEMINI_API_KEY is missing in Render Environment");
      return res.status(500).json({ matches: [], error: "GEMINI_API_KEY missing" });
    }

    const prompt = `You are a clinical Idoma language phonetic matcher.
An automatic speech recognizer heard an Idoma speaker say: "${transcript}"

ASR models transcribe Idoma phonetically and frequently make these exact distortions:
1. Vowel shifts: o <-> u, e <-> i, a <-> e (e.g. "udi ya gam" is "Ode ya gam", "ipu" vs "epu").
2. Dropped initial vowels/prefixes (e.g. "wangabo" for "Unwanga bo").
3. Merged or split word boundaries (e.g. "odiyagam" or "udi ya gam" for "Ode ya gam").
4. Doubled or dropped letters (e.g. "ikkpei" for "ikpeyi").

Pick up to 3 best matching entries from the verified glossary JSON below by comparing syllable rhythm, consonant skeleton, and vowel similarity. Always include close phonetic candidates even if confidence is moderate (55-95).
Return ONLY valid JSON:
{"matches":[{"id":"exact_id_from_glossary","confidence":80}]}
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
      console.error(`Gemini API HTTP ${apiRes.status}:`, errText);
      return res.status(502).json({ matches: [], error: `Gemini API error (${apiRes.status})` });
    }

    const data = await apiRes.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"matches":[]}';
    console.log("Gemini raw output:", rawText);

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
