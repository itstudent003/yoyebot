import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data";
import { JWT } from "google-auth-library";
import { google } from "googleapis";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set } from "firebase/database";

dotenv.config();

// ===== Google Sheets Setup =====
const SERVICE_ACCOUNT = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const MASTER_SHEET_NAME = "index";
const LOG_SHEET_ID = process.env.LOG_SHEET_ID;
const LOG_SHEET_NAME = "Logs";
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const THUNDER_API_KEY = process.env.THUNDER_API_KEY;

// ===== Google Auth =====
const auth = new JWT({
  email: SERVICE_ACCOUNT.client_email,
  key: SERVICE_ACCOUNT.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Firebase Setup =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_BUCKET,
  messagingSenderId: process.env.FIREBASE_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID,
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// ===== Utilities =====
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
        values: [
          [timestamp, eventName, role, email, name, adminUID, customerUID],
        ],
      },
    });
    console.log("🧾 Log saved:", eventName);
  } catch (err) {
    console.error("❌ Error logging event:", err.message);
  }
}

// ===== ฟังก์ชันค้นหาโซนที่นั่งด้วย UID + ชื่องาน =====
async function searchUID(uid, concertName) {
  if (!uid || !concertName)
    return `⚠️ รูปแบบไม่ถูกต้องค่ะ\nโปรดใช้รูปแบบ: ค้นหา {UID} ใน {ชื่อคอนเสิร์ต}`;

  const concertMap = await getConcertMapping();
  const target = Object.entries(concertMap).find(
    ([name]) => name.trim() === concertName.trim()
  );

  if (!target) return `❌ ไม่พบคอนเสิร์ตชื่อ "${concertName}" ใน Master Sheet`;

  const [concert, sheetId] = target;

  try {
    // ✅ ดึงข้อมูลทุกแท็บในชีต
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const sheetNames = meta.data.sheets.map((s) => s.properties.title);

    for (const sheetName of sheetNames) {
      try {
        // ✅ อ่านข้อมูลคอลัมน์ A ถึง P
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `${sheetName}!A2:P`,
        });

        const rows = res.data.values || [];
        for (const row of rows) {
          const uidValue = row[4]; // ✅ คอลัมน์ E = UID
          const nameValue = row[2]; // ชื่อผู้จอง
          const zoneValue = row[11]; // ✅ คอลัมน์ L = Zone ที่นั่ง
          const amount = row[7];       // ✅ จำนวน (H)
          const price = row[8];        // ✅ ราคาบัตร (I)
          const orderLink = row[12]; // ✅ สมมติคอลัมน์ M = ลิงก์คำสั่งซื้อ
          const round = row[6]; //✅ คอลัมน์ G = รอบการแสดง
          if (uidValue && uidValue.trim() === uid.trim()) {
            
             return (
              `♡ 𝚞𝚙𝚍𝚊𝚝𝚎 : แจ้งที่นั่งแล้วน้า ♡ 𓈒 ᐟ 🎟️✨\n` +
              `🎟️ งาน: ${concert}\n` +
              `📅 วันแสดง: ${round || "-"}\n` +
              `💸 ราคา: ${price || "-"} บาท\n` +
              `📍 โซนและที่นั่ง: ${zoneValue || "-"}\n` +
              `💺 จำนวน: ${amount || "-"} ใบ\n\n` +
              `${orderLink ? orderLink : "-"}`
            );
          }
        }
      } catch (err) {
        console.log(`⚠️ อ่านแท็บ ${sheetName} ไม่ได้: ${err.message}`);
      }
    }

    return `❌ ไม่พบ UID "${uid}" ในคอนเสิร์ต "${concertName}"`;
  } catch (err) {
    console.error(`❌ อ่านชีต ${concertName} ไม่สำเร็จ:`, err.message);
    return `⚠️ ไม่สามารถอ่านข้อมูลคอนเสิร์ต "${concertName}" ได้`;
  }
}

// ===== Express App =====
const app = express();
app.use(bodyParser.json());

app.get("/api/webhook", (req, res) => {
  res.status(200).send("🟢 LINE Webhook is running!");
});

app.post("/api/webhook", async (req, res) => {
  res.status(200).send("OK");
  const events = req.body.events || [];

  for (const event of events) {
    // ===== TEXT MESSAGE =====
    if (event.type === "message" && event.message.type === "text") {
      const message = event.message.text.trim();

      if (message === "ขอรหัสลูกค้า") {
        await replyToLine(
          event.replyToken,
          `รหัสลูกค้าคือ: ${event.source.userId}`
        );
      } else if (message.startsWith("ค้นหา")) {
        const match = message.match(/^ค้นหา\s+(.+?)(?:\s+ใน\s+(.+))?$/);
        if (!match) {
          await replyToLine(
            event.replyToken,
            `⚠️ รูปแบบที่ถูกต้อง:\n` +
              `• ค้นหา [UID] ใน [ชื่อคอนเสิร์ต]\n\n` +
              `📌 ตัวอย่างการใช้งาน:\n` +
              `ค้นหา U123abc ใน NCTConcert\n` +
              `ค้นหา U512a89 ใน Blackpink2025\n\n` +
              `ระบบจะตอบกลับโซนที่นั่งและรายละเอียดการจองของ UID นั้นค่ะ 🎟️`
          );
          return;
        }

        const keyword = match[1].trim();
        const targetConcert = match[2]?.trim() || null;
        const result = await searchUID(keyword, targetConcert);
        await replyToLine(event.replyToken, result);
      }
    }

    // ===== IMAGE MESSAGE (ตรวจสลิป) =====
    else if (event.type === "message" && event.message.type === "image") {
      try {
        const messageId = event.message.id;
        const imageRes = await fetch(
          `https://api-data.line.me/v2/bot/message/${messageId}/content`,
          { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` } }
        );
        if (!imageRes.ok) throw new Error("โหลดรูปจาก LINE ไม่สำเร็จ");
        const buffer = Buffer.from(await imageRes.arrayBuffer());

        // ส่งรูปไปที่ Thunder API
        const formData = new FormData();
        formData.append("file", buffer, {
          filename: "slip.jpg",
          contentType: "image/jpeg",
        });

        const thunderRes = await fetch("https://api.thunder.in.th/v1/verify", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${THUNDER_API_KEY}`,
            ...formData.getHeaders(),
          },
          body: formData,
        });

        const thunderData = await thunderRes.json();
        if (!thunderData?.data?.payload) {
          await replyToLine(
            event.replyToken,
            "❌ ไม่สามารถตรวจสอบสลิปได้ค่ะ ลองใหม่อีกครั้ง"
          );
          continue;
        }

        // ตรวจด้วย payload
        const payloadRes = await fetch(
          `https://api.thunder.in.th/v1/verify?payload=${thunderData.data.payload}`,
          { headers: { Authorization: `Bearer ${THUNDER_API_KEY}` } }
        );
        const slipData = await payloadRes.json();

        const transRef = slipData?.data?.transRef;
        if (!transRef) {
          await replyToLine(
            event.replyToken,
            "❌ ไม่สามารถตรวจสอบสลิปได้ค่ะ ลองใหม่อีกครั้ง"
          );
          continue;
        }

        // ตรวจซ้ำใน Firebase
        const slipRef = ref(db, `slips/${transRef}`);
        const snapshot = await get(slipRef);
        if (snapshot.exists()) {
          await replyToLine(
            event.replyToken,
            "ขออภัยค่ะ สลิปนี้ไม่สามารถใช้ได้ เพราะเป็นสลิปที่เคยส่งมาแล้วค่ะ"
          );
          continue;
        }

        // บันทึกสลิปใหม่
        await set(slipRef, slipData);

        // ส่งข้อความยืนยัน
        const { amount, date, sender, receiver } = slipData.data;

        const receiverNameTh = receiver?.account?.name?.th || "";
        const receiverNameEn = receiver?.account?.name?.en || "";

        const isCorrectReceiver = receiverNameTh.includes("น.ส. ชฎาธารี บ");

        if (!isCorrectReceiver) {
          console.warn(
            "🚫 สลิปนี้ไม่ใช่ของผู้รับที่กำหนด:",
            receiverNameTh || receiverNameEn
          );
          await replyToLine(
            event.replyToken,
            "❌ ขอโทษค่ะ สลิปนี้ไม่ใช่ของผู้รับที่ถูกต้อง (น.ส. ชฎาธารี บ)\nกรุณาตรวจสอบอีกครั้งค่ะ"
          );
          continue; // ❗ หยุดการทำงาน ไม่บันทึกลง Firebase
        }

        // ✅ ถ้าผู้รับถูกต้อง — บันทึกสลิปและตอบกลับปกติ
        const senderBank = sender?.bank?.short || sender?.bank?.name || "-";
        const senderAcc =
          sender?.account?.bank?.account ||
          sender?.account?.proxy?.account ||
          "-";
        const receiverBank =
          receiver?.bank?.short || receiver?.bank?.name || "-";
        const receiverAcc =
          receiver?.account?.bank?.account ||
          receiver?.account?.proxy?.account ||
          "-";
        const formattedDate = new Date(date).toLocaleString("th-TH", {
          timeZone: "Asia/Bangkok",
        });

        const message =
          `✅ ตรวจสลิปสำเร็จค่ะ\n\n` +
          `📅 วันที่โอน: ${formattedDate}\n` +
          `💰 ยอดโอน: ${amount?.amount || "-"} บาท\n` +
          `🏦 จาก: ${senderBank} (${senderAcc})\n` +
          `➡️ ถึง: ${receiverBank} (${receiverAcc})\n` +
          `👩‍💼 ชื่อผู้รับ: ${receiverNameTh || receiverNameEn}\n` +
          `🔖 รหัสอ้างอิง: ${slipData.data.transRef}`;

        await set(ref(db, `slips/${slipData.data.transRef}`), slipData);
        await replyToLine(event.replyToken, message);
      } catch (err) {
        console.error("❌ ตรวจสลิปล้มเหลว:", err);
        await replyToLine(
          event.replyToken,
          "⚠️ เกิดข้อผิดพลาดระหว่างตรวจสอบสลิปค่ะ กรุณาลองใหม่อีกครั้ง"
        );
      }
    }
  }
});
app.post("/api/push-line", async (req, res) => {
  try {
    const { uid, message } = req.body;

    if (!uid || !message) {
      return res.status(400).json({ error: "Missing uid or message" });
    }

    // 🔹 ส่ง LINE แบบ push ทันที
    const linePush = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: uid,
        messages: [{ type: "text", text: message }],
      }),
    });

    if (!linePush.ok) {
      const errMsg = await linePush.text();
      console.error("❌ Error sending LINE:", errMsg);
      return res.status(500).json({ error: "LINE push failed", details: errMsg });
    }

    console.log(`📤 ส่งข้อความถึง ${uid}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Push error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));


