require('dotenv').config(); // Load environment variables from .env file
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const firebaseAdmin = require('firebase-admin');
const randomstring = require('randomstring');
const axios = require('axios'); // For bot to potentially call back to website

// --- Configuration from Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const WEB_APP_URL = process.env.WEB_APP_URL; // Your website URL
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; // Provided by Render
const PORT = process.env.PORT || 10000; // Render usually listens on PORT

// --- Firebase Admin SDK Initialization ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount)
});
const db = firebaseAdmin.firestore(); // Using Firestore

const bot = new TelegramBot(TOKEN, { polling: false }); // Use webhook, not polling for Render
const app = express();
app.use(bodyParser.json());

// Set up webhook
if (RENDER_EXTERNAL_URL) {
  const webhookUrl = `${RENDER_EXTERNAL_URL}/webhook`;
  bot.setWebHook(webhookUrl).then(() => {
    console.log(`Webhook set to ${webhookUrl}`);
  }).catch(err => {
    console.error(`Error setting webhook: ${err.message}`);
  });
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// --- Global User State Management (for conversational flow) ---
const userStates = {}; // Stores { userId: { state: 'waiting_for_otp', data: {} } }
const USER_SESSION_TIMEOUT_MINUTES = 10;
const LOGIN_ALERT_TIMEOUT_MINUTES = 15;

// --- Firebase Firestore Collections ---
const usersRef = db.collection('users');
const otpsRef = db.collection('otps');
const sessionsRef = db.collection('sessions'); // For login alerts


// --- Helper Functions ---

// Function to generate OTP
function generateOtp() {
  return randomstring.generate({
    length: 6,
    charset: 'numeric'
  });
}

// Function to generate Order ID for website
function generateWebsiteOTPId() {
  return randomstring.generate({
    length: 10,
    charset: 'alphanumeric'
  }).toUpperCase();
}

// Function to show main menu (reply keyboard)
async function showMainMenu(chatId) {
  await bot.sendMessage(chatId, "🏠 **Main Menu**\n\nWelcome to Click Wallet! Choose an option:", {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        [{ text: "💰 My Wallet" }, { text: "💸 Send Money" }],
        [{ text: "🔒 Change MPIN" }, { text: "⚙️ Settings" }],
        [{ text: "📞 Support" }]
      ],
      resize_keyboard: true
    }
  });
}

// --- Bot Command Handlers ---

// /start command - Handles Telegram Login Widget redirection
bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const initData = match[1]; // Data from Telegram Login Widget (URL parameter)

  console.log(`User ${userId} started bot with data: ${initData}`);

  // This is where you would decode initData
  // For simplicity, we assume initData contains a 'redirect_to_registration' flag
  // In a real scenario, initData would be a signed JWT from Telegram.
  // The website would verify it and redirect to bot with a 'website_session_id'
  
  // For now, let's just confirm linkage
  await bot.sendMessage(chatId, "✅ **Verification Successful!**\n\nYour account is now linked. Please return to the website, the form will fill automatically.", { parse_mode: 'Markdown' });

  // Assume website URL also has a callback parameter for success
  // You would redirect the user back to the website with their Telegram ID
  // Example: rjwallet.in/login.php?telegram_id=USER_ID&first_name=...
  // The website needs to handle this redirection.

  // Store user in Firebase
  const userDoc = await usersRef.doc(userId.toString()).get();
  if (!userDoc.exists) {
    await usersRef.doc(userId.toString()).set({
      telegramId: userId.toString(),
      firstName: msg.from.first_name,
      username: msg.from.username || null,
      registeredOn: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      walletLinked: true, // Mark as linked from Telegram
      status: 'Active'
    });
  } else {
    // Update existing user, e.g., if they re-link
    await usersRef.doc(userId.toString()).update({
      firstName: msg.from.first_name,
      username: msg.from.username || null,
      walletLinked: true,
      status: 'Active'
    });
  }

  // After successful linking, you might want to show a welcome message in the bot
  await bot.sendMessage(chatId, `🤖 **Click Wallet Alert Bot** 🤖\n👋 Welcome, ${msg.from.first_name || msg.from.username}\n🆔 Your User ID: \`${userId}\`\n\n💰 **About Click Wallet:**\n• Secure digital wallet platform\n• Real-time transaction alerts\n• Instant money transfers\n• 24/7 customer support\n\n🔔 This bot will send you important alerts about your wallet activities.\n📱 Stay connected for seamless banking experience!`, { parse_mode: 'Markdown' });

  return showMainMenu(chatId);
});

// /start without data
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const users = await getSheetRows('Users'); // Check from Google Sheet as in prev request
  const userRecord = users.find(u => u.UserID == userId.toString());

  if (userRecord && userRecord.Status === 'Blocked') {
    bot.sendMessage(chatId, "🚫 **Access Denied**\nYou are blocked from this bot. Please use the 🆘 Support button to contact Admin.", { parse_mode: 'Markdown' });
    return;
  }

  if (userRecord && userRecord.Verified === 'Yes') { // Assuming verified status is set in Users sheet
    return showMainMenu(chatId);
  } else {
    // If not verified or new user, guide them to website for registration
    await bot.sendMessage(chatId, `👋 Welcome to Click Wallet! \n\nTo use this bot and link your wallet, please visit our website and connect your Telegram account.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Connect Telegram on Website", url: `${WEB_APP_URL}/login.php` }] // Link to your website's connect page
        ]
      }
    });
  }
});


// --- Website Webhook Endpoint for OTP requests and Login Alerts ---
app.post('/api/bot-action', async (req, res) => {
  const { action, telegramId, websiteData, otpPurpose, ipAddress, device, browser, os, location } = req.body;
  const targetChatId = parseInt(telegramId);

  if (isNaN(targetChatId)) {
    return res.status(400).json({ status: 'error', message: 'Invalid Telegram ID' });
  }

  // --- OTP Request ---
  if (action === 'request_otp') {
    const otp = generateOtp();
    const expiry = new Date(Date.now() + USER_SESSION_TIMEOUT_MINUTES * 60 * 1000);

    // Save OTP to Firestore
    await otpsRef.doc(targetChatId.toString()).set({
      otp: otp,
      purpose: otpPurpose,
      websiteData: websiteData,
      expiry: firebaseAdmin.firestore.Timestamp.fromDate(expiry),
      createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp()
    });

    await bot.sendMessage(targetChatId, `🎯 **ClickWallet Verification Code**\n\n🔐 Your OTP: \`${otp}\`\n\n⏰ Valid for: ${USER_SESSION_TIMEOUT_MINUTES} minutes\n📱 Website: ${WEB_APP_URL}\n🆔 Purpose: ${otpPurpose}\n\n⚠️ **Do not share this code with anyone**\n🔒 ClickWallet will never ask for your OTP`, { parse_mode: 'Markdown' });

    return res.status(200).json({ status: 'success', message: 'OTP sent' });
  }

  // --- Login Alert ---
  else if (action === 'login_alert') {
    const alertId = randomstring.generate(15);
    const expiry = new Date(Date.now() + LOGIN_ALERT_TIMEOUT_MINUTES * 60 * 1000);

    // Save session alert to Firestore
    await sessionsRef.doc(alertId).set({
      telegramId: targetChatId.toString(),
      ipAddress: ipAddress,
      device: device,
      browser: browser,
      os: os,
      location: location,
      timestamp: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      status: 'pending', // 'pending', 'approved', 'denied'
      expiry: firebaseAdmin.firestore.Timestamp.fromDate(expiry)
    });

    const timestamp = new Date().toLocaleString(); // Convert server timestamp to local string

    await bot.sendMessage(targetChatId, `🚨 **New Login Alert!**\n\n🧭 IP Address: \`${ipAddress}\`\n📱 Phone Number: (from website user data)\n🖥️ Device: ${device}\n🌐 Browser: ${browser}\n⚙️ OS: ${os}\n📍 Location: ${location}\n🗓️ Timestamp: ${timestamp}\n\n⚠️ If this wasn't you:\n📩 Please contact the admin @ClickWalletSupportBot.\n🔐 Stay safe!`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ It's Me", callback_data: `login_confirm_${alertId}` }],
          [{ text: "❌ Not Me", callback_data: `login_deny_${alertId}` }]
        ]
      }
    });
    return res.status(200).json({ status: 'success', message: 'Login alert sent' });
  }

  // --- Admin Manual OTP Request (via webhook) ---
  else if (action === 'admin_request_otp') {
    if (userId !== ADMIN_ID) { // Assuming admin makes this request via a private tool/interface
        return res.status(403).json({ status: 'error', message: 'Unauthorized' });
    }
    const otp = generateOtp();
    const expiry = new Date(Date.now() + USER_SESSION_TIMEOUT_MINUTES * 60 * 1000);
    await otpsRef.doc(targetChatId.toString()).set({
        otp: otp,
        purpose: otpPurpose || 'Admin Requested',
        expiry: firebaseAdmin.firestore.Timestamp.fromDate(expiry),
        createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp()
    });
    await bot.sendMessage(targetChatId, `🎯 **Admin Requested OTP**\n\n🔐 Your OTP: \`${otp}\`\n\n⏰ Valid for: ${USER_SESSION_TIMEOUT_MINUTES} minutes`, { parse_mode: 'Markdown' });
    return res.status(200).json({ status: 'success', message: 'Admin requested OTP sent' });
  }

  return res.status(400).json({ status: 'error', message: 'Unknown action' });
});


// --- Handle Callback Queries for Login Alerts ---
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('login_confirm_')) {
    const alertId = data.replace('login_confirm_', '');
    await sessionsRef.doc(alertId).update({ status: 'approved' });
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    bot.sendMessage(chatId, "✅ **Login confirmed!** You are now logged in.", { parse_mode: 'Markdown' });
    // You might want to notify the website about the confirmation here via another webhook call
    // await axios.post(`${WEB_APP_URL}/api/login-status-update`, { alertId: alertId, status: 'approved', telegramId: userId });
  } else if (data.startsWith('login_deny_')) {
    const alertId = data.replace('login_deny_', '');
    await sessionsRef.doc(alertId).update({ status: 'denied' });
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    bot.sendMessage(chatId, "❌ **Login denied!** Your account has been logged out.\nPlease change your password immediately and contact support.", { parse_mode: 'Markdown' });
    // Notify website for logout and password change
    // await axios.post(`${WEB_APP_URL}/api/login-status-update`, { alertId: alertId, status: 'denied', telegramId: userId });
  }
});

// --- Handle User Registration Details Display (No Account Found) ---
bot.onText(/💰 My Wallet/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const userDoc = await usersRef.doc(userId.toString()).get();
  if (userDoc.exists && userDoc.data().walletRegistered) { // Assuming a 'walletRegistered' flag on the user document
    const userData = userDoc.data();
    await bot.sendMessage(chatId, `👤 **Your Click Wallet Account Details:**\n` +
      `📛 Name: ${userData.fullName || 'N/A'}\n` +
      `🔐 Username: ${userData.username || 'N/A'}\n` +
      `📞 Phone: ${userData.phoneNumber || 'N/A'}\n` +
      `✉️ Email id: ${userData.email || 'N/A'}\n` +
      `🆔 Telegram ID: \`${userId}\`\n` +
      `🕒 Registered On: ${userData.registeredOn ? new Date(userData.registeredOn.toDate()).toLocaleString() : 'N/A'}\n\n` +
      `💰 **Current Balance: ₹0**\n\n` + // Placeholder balance
      `🚀 **Get Started:**\n• Add funds to your wallet\n• Create giveaway lifafas\n• Earn rewards and bonuses\n\n` +
      `📞 Support: @ClickWalletSupportBot Contact us if you need help!`, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(chatId, `⚠️ **No Click Wallet Account Found!**\n\nYour Telegram ID: \`${userId}\` is connected, but no wallet account is linked.\n\nPlease complete your registration on the website: ${WEB_APP_URL}/login.php`, { parse_mode: 'Markdown' });
  }
});


// --- Other User Commands (Placeholders) ---
bot.onText(/💸 Send Money/, async (msg) => {
  bot.sendMessage(msg.chat.id, "💸 Send money feature is coming soon!", { parse_mode: 'Markdown' });
});

bot.onText(/🔒 Change MPIN/, async (msg) => {
  bot.sendMessage(msg.chat.id, "🔒 Change MPIN feature is coming soon!", { parse_mode: 'Markdown' });
});

bot.onText(/⚙️ Settings/, async (msg) => {
  bot.sendMessage(msg.chat.id, "⚙️ Settings feature is coming soon!", { parse_mode: 'Markdown' });
});

bot.onText(/📞 Support/, async (msg) => {
  bot.sendMessage(msg.chat.id, "📞 For support, please contact @ClickWalletSupportBot.", { parse_mode: 'Markdown' });
});


// --- Admin Commands (Placeholder) ---
// Admin can make manual OTP requests using a specific webhook call or a bot command like /admin_otp [telegramId] [purpose]
// For now, webhook endpoint is the primary method for admin/website actions.
bot.onText(/\/admin_otp (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "🚫 Access Denied.", { parse_mode: 'Markdown' });
    }
    const targetId = parseInt(match[1]);
    const purpose = match[2];
    
    const otp = generateOtp();
    const expiry = new Date(Date.now() + USER_SESSION_TIMEOUT_MINUTES * 60 * 1000);
    await otpsRef.doc(targetId.toString()).set({
        otp: otp,
        purpose: purpose || 'Admin Requested',
        expiry: firebaseAdmin.firestore.Timestamp.fromDate(expiry),
        createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp()
    });
    await bot.sendMessage(targetId, `🎯 **Admin Requested OTP**\n\n🔐 Your OTP: \`${otp}\`\n\n⏰ Valid for: ${USER_SESSION_TIMEOUT_MINUTES} minutes`, { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, `✅ OTP sent to \`${targetId}\` for purpose: ${purpose}.`, { parse_mode: 'Markdown' });
});


// --- Unrecognized Messages / Fallback ---
bot.on('message', async (msg) => {
    // Only send fallback if it's not a command and not handled by other specific message listeners (like CAPTCHA or custom quantity)
    if (msg.text && !msg.text.startsWith('/') && !userStates[msg.from.id]) {
        await bot.sendMessage(msg.chat.id, "I don't understand that. Please use the menu buttons or commands.", { parse_mode: 'Markdown' });
        await showMainMenu(msg.chat.id);
    }
});


// --- Start the Express server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
