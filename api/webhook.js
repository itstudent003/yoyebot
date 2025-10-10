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
const MASTER_SHEET_NAME = "index"; // Master sheet มี columns: ConcertName | SpreadsheetId

// ===== LINE Config =====
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

const auth = new JWT({
  email: SERVICE_ACCOUNT.client_email,
  key: SERVICE_ACCOUNT.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const app = express();
app.use(bodyParser.json());

// ✅ อ่าน Mapping จาก Master Sheet (ConcertName -> SpreadsheetId)
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

// ✅ ค้นหาข้อมูลจากทุกคอนเสิร์ต หรือเฉพาะคอนเสิร์ตที่ระบุ
async function searchUID(keyword, targetConcert = null) {
  const concertMap = await getConcertMapping();
  let results = [];

  // ถ้ามีระบุชื่อคอนเสิร์ต → จำกัดเฉพาะนั้น
  const targets = targetConcert
    ? Object.entries(concertMap).filter(
        ([name]) => name.trim() === targetConcert.trim()
      )
    : Object.entries(concertMap);

  if (targets.length === 0)
    return `❌ ไม่พบคอนเสิร์ตชื่อ "${targetConcert}" ใน Master Sheet`;

  for (const [concertName, sheetId] of targets) {
    try {
      // 📘 ดึงชื่อแท็บทั้งหมด
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
            const order = row[0]; // A = ลำดับคิว
            const name = row[2]; // C = ชื่อ
            const phone = row[3]; // D = เบอร์
            const uid = row[4]; // E = UID

            // ✅ เงื่อนไขใหม่:
            // ถ้าไม่ได้ระบุคอนเสิร์ต → ห้ามค้นหาด้วย "ลำดับคิว"
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
          console.log(
            `⚠️ อ่านแท็บ ${sheetName} ของ ${concertName} ไม่ได้: ${err.message}`
          );
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

// ✅ ตอบกลับ LINE
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

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");

  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const message = event.message.text.trim();
      const userId = event.source.userId;

      // ✅ ขอรหัสลูกค้า
      if (message === "ขอรหัสลูกค้า") {
        await replyToLine(event.replyToken, `รหัสลูกค้าคือ: ${userId}`);
      }

      // ✅ ค้นหา UID จากทุกชีต
      else if (message.startsWith("ค้นหา")) {
        // แยกข้อความ เช่น "ค้นหา itstudent ใน SupalaiConcert"
        const match = message.match(/^ค้นหา\s+(.+?)(?:\s+ใน\s+(.+))?$/);
        if (!match) {
          await replyToLine(
            event.replyToken,
            `⚠️ รูปแบบที่ถูกต้อง:\n` +
              `• ค้นหา [ชื่อ] หรือ [เบอร์โทร] → ค้นหาทุกคอนเสิร์ตในระบบ\n` +
              `• ค้นหา [คำค้น] ใน [ชื่อคอนเสิร์ต] → ค้นหาเฉพาะคอนเสิร์ตนั้น\n` +
              `\n📌 หมายเหตุ: การค้นหาด้วย "ลำดับคิว" (เช่น ค้นหา 5) จะใช้ได้เฉพาะเมื่อระบุชื่อคอนเสิร์ตเท่านั้น\n` +
              `ตัวอย่าง:\nค้นหา itstudent\nค้นหา itstudent ใน SupalaiConcert\nค้นหา 5 ใน Blackpink2025`
          );
          return;
        }

        const keyword = match[1].trim();
        const targetConcert = match[2]?.trim() || null;

        const result = await searchUID(keyword, targetConcert);
        await replyToLine(event.replyToken, result);
      }

      //   // ❌ ไม่เข้าเงื่อนไข
      //   else {
      //     await replyToLine(
      //       event.replyToken,
      //       `พิมพ์ "ขอรหัสลูกค้า" เพื่อดู UID หรือ "ค้นหา [คำค้น]" เพื่อค้นหาในทุกคอนเสิร์ต`
      //     );
      //   }
    }
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
