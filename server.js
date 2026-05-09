import express from "express";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
import multer from "multer";
import cors from "cors";

console.log("🔥 Server starting...");

dotenv.config();

const app = express();

const upload = multer({
  dest: "uploads/",
});

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 🔹 CREATE EMBEDDING
async function createEmbedding(text) {
  try {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });

    return res.data[0].embedding;
  } catch (e) {
    console.error(
      "❌ Embedding Error:",
      e
    );

    throw e;
  }
}

// 🔹 EXTRACT TASKS
async function extractTasks(note) {
  try {
    console.log(
      "📋 Extracting tasks..."
    );

    const response =
      await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              'Extract action items from the meeting. Return ONLY valid JSON array in this format: [{"task":"...","owner":"...","deadline":"..."}]',
          },
          {
            role: "user",
            content: note.content,
          },
        ],
      });

    let raw =
      response.choices[0].message.content;

    console.log(
      "🔍 Raw Tasks Response:",
      raw
    );

    raw = raw
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let tasks = [];

    try {
      tasks = JSON.parse(raw);
    } catch (jsonErr) {
      console.error(
        "❌ JSON Parse Error:",
        jsonErr
      );

      return [];
    }

    // Save tasks
    for (const t of tasks) {
      await supabase.from("tasks").insert({
        note_id: note.id,
        task: t.task || "",
        owner: t.owner || "",
        deadline: t.deadline || "",
      });
    }

    return tasks;
  } catch (e) {
    console.error(
      "❌ Task Extraction Error:",
      e
    );

    return [];
  }
}

// 🎙️ PROCESS AUDIO
app.post(
  "/process-audio",
  upload.single("audio"),
  async (req, res) => {
    try {
      console.log(
        "🎙️ Processing audio..."
      );

      if (!req.file) {
        return res.status(400).json({
          error:
            "No audio file uploaded",
        });
      }

      // ✅ GET EMAIL
      const email =
        req.body.email || "";

      console.log(
        "📧 User Email:",
        email
      );

      console.log(
        "📁 File received:",
        req.file.originalname
      );

      // 🔥 TRANSCRIBE AUDIO
      const transcription =
        await openai.audio.transcriptions.create(
          {
            file: await toFile(
              fs.createReadStream(
                req.file.path
              ),
              req.file.originalname
            ),
            model: "gpt-4o-transcribe",
          }
        );

      const text = transcription.text;

      console.log(
        "📝 Transcription completed"
      );

      // 💾 SAVE NOTE + EMAIL
      const {
        data: note,
        error,
      } = await supabase
        .from("notes")
        .insert({
          content: text,
          email: email,
        })
        .select()
        .single();

      if (error) {
        console.error(
          "❌ Supabase Insert Error:",
          error
        );

        throw error;
      }

      console.log("💾 Note saved");

      // 🤖 GENERATE SUMMARY
      const summaryRes =
        await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Summarize this meeting clearly with key decisions and important points.",
            },
            {
              role: "user",
              content: text,
            },
          ],
        });

      const summary =
        summaryRes.choices[0].message.content;

      await supabase
        .from("notes")
        .update({ summary })
        .eq("id", note.id);

      console.log(
        "🤖 Summary generated"
      );

      // 🧠 CREATE EMBEDDING
      const embedding =
        await createEmbedding(text);

      await supabase
        .from("embeddings")
        .insert({
          note_id: note.id,
          chunk: text,
          embedding,
        });

      console.log(
        "🧠 Embedding stored"
      );

      // 📋 EXTRACT TASKS
      const tasks = await extractTasks({
        id: note.id,
        content: text,
      });

      console.log(
        "📋 Tasks extracted"
      );

      // 🚀 SEND TO N8N
      try {
        await fetch(
          "https://gandhamphani.app.n8n.cloud/webhook/meeting-summary",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              email,
              summary,
              tasks,
              transcription: text,
            }),
          }
        );

        console.log(
          "✅ n8n webhook triggered"
        );
      } catch (webhookErr) {
        console.error(
          "❌ n8n Webhook Error:",
          webhookErr
        );
      }

      // 🔥 FINAL RESPONSE
      const responsePayload = {
        transcription: text,
        summary,
        tasks,
      };

      console.log(
        "✅ Sending response:",
        responsePayload
      );

      res.json(responsePayload);
    } catch (err) {
      console.error(
        "❌ API Error:",
        err
      );

      res.status(500).json({
        error: "Processing failed",
      });
    }
  }
);

// 📊 DAILY EXECUTIVE DIGEST
app.get(
  "/daily-digest",
  async (req, res) => {
    try {
      console.log(
        "📊 Generating daily digest..."
      );

      const { data, error } =
        await supabase
          .from("notes")
          .select("*")
          .order("id", {
            ascending: false,
          })
          .limit(10);

      if (error) {
        console.error(
          "❌ Supabase Fetch Error:",
          error
        );

        throw error;
      }

      if (!data || data.length === 0) {
        return res.json({
          success: true,
          digest:
            "No meetings processed today.",
          meetingsCount: 0,
        });
      }

      // ✅ DYNAMIC EMAIL
      const email =
        data[0]?.email || "";

      const combinedMeetings =
        data
          .map(
            (item, index) => `
Meeting ${index + 1}

Summary:
${item.summary || "No summary"}

Transcript:
${item.content || "No transcript"}
`
          )
          .join("\n\n");

      const digestPrompt = `
You are an executive AI assistant.

Create a professional executive digest from these meetings.

Include:
- Overall business summary
- Major action items
- Key risks/issues
- Important decisions
- Executive insights

Meetings:
${combinedMeetings}
`;

      const digestResponse =
        await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: digestPrompt,
            },
          ],
        });

      const digest =
        digestResponse.choices[0].message
          .content;

      console.log(
        "✅ Daily digest generated"
      );

      res.json({
        success: true,
        digest,
        meetingsCount: data.length,
        email,
      });
    } catch (err) {
      console.error(
        "❌ Daily Digest Error:",
        err
      );

      res.status(500).json({
        error:
          "Failed to generate daily digest",
      });
    }
  }
);

// 💬 RAG QUESTION ANSWERING
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    console.log(
      "❓ Question received:",
      question
    );

    // Create embedding
    const embedding =
      await createEmbedding(question);

    // Retrieve similar notes
    const { data, error } =
      await supabase.rpc(
        "match_embeddings",
        {
          query_embedding: embedding,
          match_threshold: 0.0,
          match_count: 5,
        }
      );

    if (error) {
      console.error(
        "❌ Match Error:",
        error
      );

      throw error;
    }

    const context = data
      .map((d) => d.chunk)
      .join("\n");

    console.log(
      "📚 Context Retrieved"
    );

    // Ask AI using context
    const response =
      await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Answer ONLY using the provided context. If answer not found, say you don't know.",
          },
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion:\n${question}`,
          },
        ],
      });

      const answer =
        response.choices[0].message.content;

      res.json({ answer });
    } catch (err) {
      console.error(
        "❌ RAG Error:",
        err
      );

      res.status(500).json({
        error: "RAG failed",
      });
    }
  }
);

// 🟢 HEALTH CHECK
app.get("/", (req, res) => {
  res.send("✅ API Running");
});

// 🚀 START SERVER
app.listen(3000, () => {
  console.log(
    "🚀 Server running at http://localhost:3000"
  );
});