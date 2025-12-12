import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data";
import mongoose from "mongoose";
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
const MONGO_URI = process.env.MONGO_URI;

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

// ===== MongoDB Setup =====
mongoose
  .connect(MONGO_URI, {
    dbName: "linebot",
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// User schema (LINE users) - เปลี่ยนจาก assignedTo เป็น assignedWorkers array
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  picture: String,
  status: String,
  assignedWorkers: [{ type: mongoose.Schema.Types.ObjectId, ref: "Worker" }], // เปลี่ยนเป็น array
});
const User = mongoose.model("User", userSchema);

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
          const amount = row[7]; // ✅ จำนวน (H)
          const price = row[8]; // ✅ ราคาบัตร (I)
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
async function getUserProfile(userId) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: {
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("❌ Error fetching profile:", errorText);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("❌ Error fetching profile:", err.message);
    return null;
  }
}

// ===== Express App =====
const app = express();
app.use(bodyParser.json());

app.get("/api/webhook", (req, res) => {
  res.status(200).send("🟢 LINE Webhook is running!");
});

// ====== LINE Webhook (รวม user-register + text + image) ======
app.post("/api/webhook", async (req, res) => {
  // ตอบ 200 กลับไปก่อน เพื่อไม่ให้ LINE timeout
  res.status(200).send("OK");

  const events = req.body.events || [];
  for (const event of events) {
    // -----------------------------
    // A) ลงทะเบียนผู้ใช้ใหม่ (ครั้งแรก)
    // -----------------------------
    try {
      const userId = event?.source?.userId;
      if (userId) {
        const exists = await User.exists({ userId });
        if (!exists) {
          const profile = await getUserProfile(userId);
          if (profile) {
            const user = new User({
              userId: profile.userId,
              name: profile.displayName,
              picture: profile.pictureUrl,
              status: profile.statusMessage || "",
              assignedWorkers: [],
            });
            await user.save();
            console.log("✅ บันทึกผู้ใช้ใหม่:", profile.displayName);
          }
        } else {
          console.log("ℹ️ พบ userId ซ้ำ, ไม่บันทึกซ้ำ:", userId);
        }
      }
    } catch (saveErr) {
      console.error(
        "❌ Error saving to Mongo (user register):",
        saveErr.message
      );
    }

    // -----------------------------
    // B) จัดการข้อความตัวอักษร
    // -----------------------------
    if (event.type === "message" && event.message.type === "text") {
      const message = event.message.text.trim();
      const userId = event.source.userId;

      // คีย์เวิร์ดแนะนำขั้นตอนบริการ
      if (
        /สนใจ\s*(สอบถาม|ติดต่อ)?\s*และ\s*จ้าง\s*กดบัตร(ค่ะ|ครับ)?/i.test(
          message
        )
      ) {
        const replyText = `♡ 𓈒 ᐟ สวัสดีค่า ยินดีต้อนรับสู่บริการกดบัตรยยมือทองนะคะ 🐰💗  
ขอแจ้งขั้นตอนการรับคิวผ่าน LINE OA ให้ลูกค้าเข้าใจง่ายๆ ก่อนนะคะ ⤵  

♡ ขั้นตอนการรับคิวกดบัตรผ่าน LINE OA  

1) ลูกค้าส่งรายละเอียดงาน ✅  
 └ ชื่องาน + โซน/ราคา + จำนวนบัตรที่ต้องการ  

2) ร้านส่งฟอร์มข้อตกลงให้ลูกค้าอ่าน ✍️  
 └ ลูกค้ากรอกยืนยันรับทราบเงื่อนไข  

3) ร้านแจ้งยอดมัดจำ + ส่งฟอร์มมัดจำ 💸  
 └ ลูกค้าโอนมัดจำ → ส่งสลิป → กรอกฟอร์มยืนยันคิว  
🕘 หากลูกค้าไม่ดำเนินการโอนภายในเวลาที่กำหนด ระบบจะถือว่าสละสิทธิ์คิวอัตโนมัตินะคะ 💗  

4) ร้านส่งฟอร์มรายละเอียดกดบัตรให้กรอก 🎟️  
 └ เพื่อบันทึกข้อมูลงาน/ลำดับคิวในระบบ  

5) หากฝากร้านชำระค่าบัตร 💳  
 └ ใกล้ๆวันกด ร้านจะแจ้งยอดชำระค่าบัตร + ส่งฟอร์มให้กรอก  

6) สถานะ: รอวันกดบัตร ⏳  

7) วันกดบัตร 🎫  
 └ ร้านแจ้งสแตนบาย + อัปเดตสถานการณ์การกด ในไลน์นี้  

8) หากกดได้ ✅  
 └ ร้านส่งรายละเอียดบัตร + สรุปยอดค่ากด  
 └ ลูกค้าโอนค่ากดส่วนที่เหลือ + กรอกฟอร์มยืนยันการชำระเงิน  

9) หากกดไม่ได้ ❌  
 └ ร้านส่งฟอร์มคืนเงินให้กรอก  
 └ โอนคืนตามเงื่อนไขร้านอย่างรวดเร็วค่ะ 🤍✨  

📎 ระบบเก็บข้อมูล+สลิปทุกออเดอร์เพื่อความปลอดภัยค่ะ  
ขอบคุณที่ไว้วางใจให้ยยมือทองกดบัตรให้นะคะ 🐰💗  

พร้อมเริ่มแล้วลูกค้าส่งรายละเอียดงานได้เลยนะคะ 💬🌷`;
        await replyToLine(event.replyToken, replyText);
        continue;
      }

      // ผู้ใช้พิมพ์ “หยุดกดได้เลย”
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

                // อัปเดตคอลัมน์ N (หยุดกด)
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

                // แจ้งกลุ่ม LINE
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

                // บันทึก Log
                const eventName = `หยุดกด (ลูกค้าได้บัตรเอง) - ${fileName} / รอบ: ${roundDate}`;
                await logEvent(eventName, "Customer", "-", "-", "-", userId);

                return; // จบ loop event นี้
              }
            }
          } catch (err) {
            console.error(`⚠️ อ่านชีต ${concertName} ไม่ได้:`, err.message);
          }
        }

        await replyToLine(event.replyToken, "❌ ไม่พบข้อมูลในระบบค่ะ");
        continue;
      }

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
          continue;
        }
        const keyword = match[1].trim();
        const targetConcert = match[2]?.trim() || null;
        const result = await searchUID(keyword, targetConcert);
        await replyToLine(event.replyToken, result);
      }
    }

    // -----------------------------
    // C) จัดการภาพ (ตรวจสลิปเท่านั้น)
    // -----------------------------
    else if (event.type === "message" && event.message.type === "image") {
      try {
        const messageId = event.message.id;

        // 1) ดึงภาพจาก LINE
        const imageRes = await fetch(
          `https://api-data.line.me/v2/bot/message/${messageId}/content`,
          { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` } }
        );
        if (!imageRes.ok) throw new Error("โหลดรูปจาก LINE ไม่สำเร็จ");
        const buffer = Buffer.from(await imageRes.arrayBuffer());

        // 2) ส่งไปตรวจที่ Thunder
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
        const thunderJson = await thunderRes.json().catch(() => null);
        // console.log("SlipData: ", thunderJson);
        // console.log("Thunder Response OK:", thunderRes.ok);

        // 3) ถ้าไม่ใช่สลิป → เงียบ ไม่ตอบใดๆ
        const isValidSlip =
          thunderRes.ok &&
          thunderJson &&
          thunderJson.status === 200 &&
          thunderJson.data &&
          thunderJson.data.transRef;

        if (!isValidSlip) {
          console.log("⏭️ ข้ามภาพที่ไม่ใช่สลิป");
          continue;
        }

        // 4) ตรวจชื่อผู้รับ + กันสลิปซ้ำ
        const slipData = thunderJson;
        const transRef = slipData.data.transRef;

        const slipRef = ref(db, `slips/${transRef}`);
        const snapshot = await get(slipRef);
        if (snapshot.exists()) {
          await replyToLine(
            event.replyToken,
            `⚠️ สลิปนี้ถูกใช้งานในระบบแล้วค่ะ  
(This slip has already been used.)  

หากลูกค้าส่งสลิปเดิมซ้ำจากความผิดพลาด  
สามารถแจ้งแอดมินเพื่อตรวจสอบได้เลยนะคะ 🤍✨  
(Please contact admin for manual review if needed.)`
          );
          continue;
        }

        const receiverNameTh =
          slipData?.data?.receiver?.account?.name?.th || "";
        const receiverNameEn =
          slipData?.data?.receiver?.account?.name?.en || "";
        const EXPECTED_RECEIVER = /(บจก\.\s*โยเย\s*ม|YOYE\s*MUETHONG\s*CO\.,?LTD\.?)/i;

        if (
          !EXPECTED_RECEIVER.test(receiverNameTh) &&
          !EXPECTED_RECEIVER.test(receiverNameEn)
        ) {
          console.warn(
            "🚫 สลิปผู้รับไม่ถูกต้อง:",
            receiverNameTh || receiverNameEn
          );
          await replyToLine(
            event.replyToken,
            `❌ ขออภัยค่ะ ยังไม่พบข้อมูลสลิปนี้ในระบบนะคะ  
(Slip not found in our system.)  

บอทตรวจสอบเฉพาะยอดที่โอนเข้าบัญชีร้านเท่านั้นนะคะ  
(The system only detects transfers to the official account.)  

หากโอนไปบัญชีอื่นหรือสงสัยเพิ่มเติม  
แจ้งแอดมินเพื่อตรวจสอบได้เลยค่ะ 🤍✨  
(Please contact admin for assistance.)`
          );

          continue;
        }

        // ✅ ผ่านทั้งหมด → บันทึกและตอบกลับ
        await set(slipRef, slipData);

        const { amount, date, sender, receiver } = slipData.data;
        const senderBank = sender?.bank?.short || sender?.bank?.name || "-";
        const senderAcc =
          sender?.account?.bank?.account ||
          sender?.account?.proxy?.account ||
          "-";
        // const receiverBank =
        //   receiver?.bank?.short || receiver?.bank?.name || "-";
        // const receiverAcc =
        //   receiver?.account?.bank?.account ||
        //   receiver?.account?.proxy?.account ||
        //   "-";
        const formattedDate = new Date(date);
        const dateTH = formattedDate.toLocaleDateString("th-TH", {
          timeZone: "Asia/Bangkok",
        });
        const timeTH = formattedDate.toLocaleTimeString("th-TH", {
          timeZone: "Asia/Bangkok",
        });

        const msg =
          `✅ ตรวจสอบสลิปเรียบร้อยค่ะ ♡  \n` +
          `(Payment verified successfully.)\n\n` +
          `📅 วันที่โอน: ${dateTH}\n` +
          `⏰ เวลา: ${timeTH}\n` +
          `💸 จำนวนเงิน: ${amount?.amount ?? "-"} บาท\n` +
          `🏦 จากบัญชี:  ${senderBank} (${senderAcc})\n\n` +
          `ยอดเข้าบัญชีร้านเรียบร้อยแล้วนะคะ ขอบคุณค่ะ 🐰🌷\n ` +
          `(Your payment has been received. Thank you!)\n `;

        await replyToLine(event.replyToken, msg);
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
      return res
        .status(500)
        .json({ error: "LINE push failed", details: errMsg });
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

