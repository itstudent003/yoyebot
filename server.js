import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { JWT } from "google-auth-library";
import { google } from "googleapis";

dotenv.config();

// ===== Google Sheets Setup =====
const SERVICE_ACCOUNT = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const MASTER_SHEET_NAME = "index";

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

const auth = new JWT({
  email: SERVICE_ACCOUNT.client_email,
  key: SERVICE_ACCOUNT.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const app = express();
app.use(bodyParser.json());

// ===== Utilities =====
async function getConcertMapping() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${MASTER_SHEET_NAME}!A2:B`,
  });

  const rows = res.data.values || [];
  const map = {};
  for (const [concert, id] of rows) {
    if (concert && id) map[concert.trim()] = id.trim();
  }
  return map;
}

async function searchUID(keyword, targetConcert = null) {
  const concertMap = await getConcertMapping();
  let results = [];

  const targets = targetConcert
    ? Object.entries(concertMap).filter(
        ([name]) => name.trim() === targetConcert.trim()
      )
    : Object.entries(concertMap);

  if (targets.length === 0)
    return `❌ ไม่พบคอนเสิร์ตชื่อ "${targetConcert}" ใน Master Sheet`;

  for (const [concertName, sheetId] of targets) {
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
      const sheetNames = meta.data.sheets.map((s) => s.properties.title);

      for (const sheetName of sheetNames) {
        try {
          const res = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: `${sheetName}!A2:E`,
          });

          const rows = res.data.values || [];
          for (const row of rows) {
            const order = row[0];
            const name = row[2];
            const phone = row[3];
            const uid = row[4];

            const matchByOrder =
              targetConcert && order && order.toString() === keyword;
            const matchByName = name && name.includes(keyword);
            const matchByPhone = phone && phone.includes(keyword);

            if (matchByOrder || matchByName || matchByPhone) {
              results.push(
                `🎟️ [${concertName} - ${sheetName}]\nลำดับ: ${order}\nชื่อ: ${name}\nเบอร์: ${phone}\nUID: ${uid}`
              );
            }
          }
        } catch (err) {
          console.log(`⚠️ อ่านแท็บ ${sheetName} ของ ${concertName} ไม่ได้: ${err.message}`);
        }
      }
    } catch (err) {
      console.log(`⚠️ อ่านไฟล์ ${concertName} ไม่ได้: ${err.message}`);
    }
  }

  if (results.length === 0)
    return `❌ ไม่พบ "${keyword}" ใน${
      targetConcert
        ? `คอนเสิร์ต "${targetConcert}"`
        : "ทุกคอนเสิร์ตใน Master Sheet"
    }`;

  return results.join("\n\n");
}

async function replyToLine(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const payload = JSON.stringify({
    replyToken,
    messages: [{ type: "text", text }],
  });

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
    },
    body: payload,
  });
}

// ===== Webhook Endpoint =====
app.get("/api/webhook", (req, res) => {
  res.status(200).send("🟢 LINE Webhook is running!");
});

// ===== Webhook Endpoint =====
app.post("/api/webhook", async (req, res) => {
  res.status(200).send("OK");

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const message = event.message.text.trim();
      const userId = event.source.userId;

      if (message === "ขอรหัสลูกค้า") {
        await replyToLine(event.replyToken, `รหัสลูกค้าคือ: ${userId}`);
      } else if (message.startsWith("ค้นหา")) {
        const match = message.match(/^ค้นหา\s+(.+?)(?:\s+ใน\s+(.+))?$/);
        if (!match) {
          await replyToLine(
            event.replyToken,
            `⚠️ รูปแบบที่ถูกต้อง:\n` +
              `• ค้นหา [ชื่อ] หรือ [เบอร์โทร] → ค้นหาทุกคอนเสิร์ต\n` +
              `• ค้นหา [คำค้น] ใน [ชื่อคอนเสิร์ต] → ค้นหาเฉพาะคอนเสิร์ตนั้น\n` +
              `\n📌 การค้นหาด้วย "ลำดับคิว" ใช้ได้เฉพาะเมื่อระบุชื่อคอนเสิร์ตเท่านั้น\n` +
              `ตัวอย่าง:\nค้นหา itstudent\nค้นหา itstudent ใน SupalaiConcert\nค้นหา 5 ใน Blackpink2025`
          );
          return;
        }

        const keyword = match[1].trim();
        const targetConcert = match[2]?.trim() || null;
        const result = await searchUID(keyword, targetConcert);
        await replyToLine(event.replyToken, result);
      }

      // ✅ เพิ่มส่วนนี้: ตรวจสลิปด้วย Thunder API
    } else if (event.type === "message" && event.message.type === "image") {
      try {
        const messageId = event.message.id;
        const userId = event.source.userId;

        // ดึงไฟล์รูปจาก LINE
        const imageRes = await fetch(
          `https://api-data.line.me/v2/bot/message/${messageId}/content`,
          {
            headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
          }
        );

        if (!imageRes.ok) throw new Error("โหลดรูปจาก LINE ไม่สำเร็จ");

        const buffer = Buffer.from(await imageRes.arrayBuffer());

        // ส่งรูปไปตรวจที่ Thunder API
        const formData = new FormData();
        formData.append("file", buffer, {
          filename: "slip.jpg",
          contentType: "image/jpeg",
        });

        const thunderRes = await fetch("https://api.thunder.in.th/v1/verify", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.THUNDER_API_KEY || ""}`, // ใส่ถ้ามี API key
            ...formData.getHeaders(),
          },
          body: formData,
        });

        const result = await thunderRes.json();
        console.log("📩 ผลจาก Thunder:", result);

        // ตอบกลับผู้ใช้ตามผลตรวจ
        if (result.status === 200 && result.data) {
          const { amount, date, sender, receiver, transRef } = result.data;

          const senderBank = sender?.bank?.short || sender?.bank?.name || "-";
          const senderAcc = sender?.account?.number || "-";
          const receiverBank =
            receiver?.bank?.short || receiver?.bank?.name || "-";
          const receiverAcc = receiver?.account?.number || "-";
          const amountValue = amount?.amount || "-";

          const formattedDate = new Date(date).toLocaleString("th-TH", {
            timeZone: "Asia/Bangkok",
          });

          const message =
            `✅ ตรวจสลิปสำเร็จค่ะ\n\n` +
            `📅 วันที่โอน: ${formattedDate}\n` +
            `💰 ยอดโอน: ${amountValue} บาท\n` +
            `🏦 จาก: ${senderBank} (${senderAcc})\n` +
            `➡️ ถึง: ${receiverBank} (${receiverAcc})\n` +
            `🔖 รหัสอ้างอิง: ${transRef}`;

          await replyToLine(event.replyToken, message);
        } else {
          console.log(
            "⚠️ Thunder API response ไม่ตรง format ที่คาดไว้:",
            result
          );
          await replyToLine(
            event.replyToken,
            "❌ ไม่สามารถตรวจสอบสลิปได้ค่ะ ลองใหม่อีกครั้ง"
          );
        }
      } catch (err) {
        console.error("❌ ตรวจสลิปล้มเหลว:", err);
        await replyToLine(
          event.replyToken,
          "⚠️ เกิดข้อผิดพลาดระหว่างตรวจสอบสลิปค่ะ"
        );
      }
    }
  }
});

// ✅ Export app for Vercel
export default app;
