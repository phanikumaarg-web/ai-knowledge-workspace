import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 🔹 Create Embedding
async function createEmbedding(text) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  return res.data[0].embedding;
}

// 🔹 Voice → Text
async function transcribeAudio(filePath) {
  console.log("🎙️ Transcribing audio...");

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "gpt-4o-transcribe",
  });

  console.log("\n📝 Transcription:\n", transcription.text);

  return transcription.text;
}

// 🔹 RAG Q&A
async function askQuestion(question) {
  console.log("\n❓ Question:", question);

  const queryEmbedding = await createEmbedding(question);

  const { data, error } = await supabase.rpc("match_embeddings", {
    query_embedding: queryEmbedding,
    match_threshold: 0.0,
    match_count: 5,
  });

  if (error) {
    console.error("❌ RAG Error:", error);
    return;
  }

  if (!data || data.length === 0) {
    console.log("❌ No relevant context found");
    return;
  }

  const context = data.map(item => item.chunk).join("\n");

  console.log("\n📚 Context Retrieved:\n", context);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "Answer only using the provided context",
      },
      {
        role: "user",
        content: `Context:\n${context}\n\nQuestion:\n${question}`,
      },
    ],
  });

  console.log("\n🧠 AI Answer:\n", response.choices[0].message.content);
}

// 🔹 Task Extraction (FIXED)
async function extractTasks(note) {
  console.log("📋 Extracting tasks...");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Extract tasks from the note.

Return ONLY JSON array.
No explanation.
No markdown.
No backticks.

Format:
[
  {
    "task": "...",
    "owner": "...",
    "deadline": "..."
  }
]
        `,
      },
      {
        role: "user",
        content: note.content,
      },
    ],
  });

  let raw = response.choices[0].message.content;

  console.log("🔍 Raw AI response:\n", raw);

  // Clean markdown if present
  raw = raw.replace(/```json/g, "").replace(/```/g, "").trim();

  let tasks;

  try {
    tasks = JSON.parse(raw);
  } catch (e) {
    console.log("❌ JSON parse failed after cleanup");
    return;
  }

  for (const t of tasks) {
    const { error } = await supabase.from("tasks").insert({
      note_id: note.id,
      task: t.task || "",
      owner: t.owner || "",
      deadline: t.deadline || "",
    });

    if (error) {
      console.error("❌ Insert error:", error);
    }
  }

  console.log("✅ Tasks stored:", tasks.length);
}

// 🔹 Process Note
async function processNote(note) {
  console.log("\n📝 Processing Note:\n", note.content);

  // Summary
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Summarize clearly with key points and action items",
      },
      {
        role: "user",
        content: note.content,
      },
    ],
  });

  const summary = response.choices[0].message.content;

  console.log("\n🤖 Summary:\n", summary);

  await supabase
    .from("notes")
    .update({ summary })
    .eq("id", note.id);

  console.log("✅ Summary saved");

  // Embedding
  console.log("➡️ Creating embedding...");

  const embedding = await createEmbedding(note.content);

  await supabase.from("embeddings").insert({
    note_id: note.id,
    chunk: note.content,
    embedding,
  });

  console.log("✅ Embedding stored");

  // Task extraction
  await extractTasks(note);
}

// 🔹 Voice Flow (MAIN)
async function runVoiceFlow() {
  const text = await transcribeAudio("test.mp3");

  const { data, error } = await supabase
    .from("notes")
    .insert({ content: text })
    .select()
    .single();

  if (error) {
    console.error("❌ Insert error:", error);
    return;
  }

  console.log("✅ Voice note saved");

  await processNote(data);

  await askQuestion("What decisions were made?");
}

// 🚀 RUN
runVoiceFlow();