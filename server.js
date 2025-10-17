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
const LOG_SHEET_ID = process.env.LOG_SHEET_ID; // ✅ ชีตเก็บ Logs
const LOG_SHEET_NAME = "Logs";

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

async function logEvent(eventName, role, email, name, adminUID, customerUID) {
  try {
    const timestamp = new Date().toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok",
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: LOG_SHEET_ID,
      range: LOG_SHEET_NAME,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[timestamp, eventName, role, email, name, adminUID, customerUID]],
      },
    });
    console.log("🧾 Log saved:", eventName);
  } catch (err) {
    console.error("❌ Error logging event:", err.message);
  }
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

app.post("/api/webhook", async (req, res) => {
  res.status(200).send("OK");

  const events = req.body.events || [];

  // ✅ Forward event ทั้งหมดไปยัง Thunder webhook
  try {
    await fetch("https://line.thunder.in.th/api/v1/webhook/e4a3587a-9a99-40f1-8efa-3582c8a47db4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    console.log("✅ Forwarded to Thunder webhook");
  } catch (err) {
    console.error("❌ Error forwarding to Thunder:", err.message);
  }

  // ✅ เริ่มทำงาน logic เดิมของคุณ
  for (const event of events) {
    const source = event.source || {};

    // ✅ เมื่อบอทถูกเชิญเข้ากลุ่ม
    if (event.type === "join" && source.type === "group") {
      console.log("🆕 Bot ถูกเชิญเข้ากลุ่มใหม่!");
      console.log("📌 Group ID:", source.groupId);
      await replyToLine(
        event.replyToken,
        `✅ บอทพร้อมใช้งานแล้วในกลุ่มนี้!\nGroup ID: ${source.groupId}`
      );
      continue;
    }

    // ✅ เมื่อบอทได้รับข้อความ
    if (event.type === "message" && event.message.type === "text") {
      const message = event.message.text.trim();
      const userId = event.source.userId;

      // ✅ เมื่อผู้ใช้พิมพ์ “หยุดกดได้เลย”
      if (/หยุดกดได้เลย/i.test(message)) {
        console.log(`🛑 ผู้ใช้ ${userId} แจ้งหยุดกดแล้ว`);

        const concertMap = await getConcertMapping();
        for (const [concertName, sheetId] of Object.entries(concertMap)) {
          try {
            const res = await sheets.spreadsheets.values.get({
              spreadsheetId: sheetId,
              range: "A2:O",
            });

            const rows = res.data.values || [];
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              const uidCell = row[4]; // E
              if (uidCell === userId) {
                console.log(`✅ พบ UID ใน ${concertName}, แถว ${i + 2}`);

                // ✅ อัปเดตคอลัมน์ N (หยุดกด)
                await sheets.spreadsheets.values.update({
                  spreadsheetId: sheetId,
                  range: `N${i + 2}`,
                  valueInputOption: "USER_ENTERED",
                  requestBody: { values: [[true]] },
                });

                const fileName = concertName;
                const roundDate = row[6] || "-"; // G
                const queueNo = row[0] || "-";
                const operator = "ลูกค้า (ผ่าน LINE OA)";
                const notifiedAt = new Date().toLocaleString("th-TH", {
                  timeZone: "Asia/Bangkok",
                });

                // ✅ แจ้งกลุ่ม LINE
                const groupMessage =
                  `[🛑 หยุดกด – ลูกค้าได้บัตรเองแล้ว]\n\n` +
                  `งาน: ${fileName}\n` +
                  `คิว: ${queueNo}\n` +
                  `รอบการแสดง: ${roundDate}\n` +
                  `ลูกค้า: (UID: ${userId})\n` +
                  `โดย: ${operator} | เวลา: ${notifiedAt}`;

                await fetch("https://api.line.me/v2/bot/message/push", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
                  },
                  body: JSON.stringify({
                    to: process.env.LINE_GROUP_ID,
                    messages: [{ type: "text", text: groupMessage }],
                  }),
                });

                console.log("📩 ส่งแจ้งเตือนไปกลุ่มเรียบร้อย");

                // ✅ บันทึก Log
                const eventName = `หยุดกด (ลูกค้าได้บัตรเอง) - ${fileName} / รอบ: ${roundDate}`;
                await logEvent(
                  eventName,
                  "Customer",
                  "-",
                  "-",
                  "-",
                  userId
                );

                return;
              }
            }
          } catch (err) {
            console.error(`⚠️ อ่านชีต ${concertName} ไม่ได้:`, err.message);
          }
        }

        await replyToLine(event.replyToken, "❌ ไม่พบข้อมูลในระบบค่ะ");
        continue;
      }

      // ✅ คำสั่งอื่น (ค้นหา / ขอรหัส)
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
              `\n📌 ตัวอย่าง:\nค้นหา itstudent\nค้นหา itstudent ใน SupalaiConcert`
          );
          return;
        }

        const keyword = match[1].trim();
        const targetConcert = match[2]?.trim() || null;
        const result = await searchUID(keyword, targetConcert);
        await replyToLine(event.replyToken, result);
      }
    }
  }
});

// ===== ฟังก์ชัน Search UID (เดิม) =====
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

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

