require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { db } = require("./db/db");
const { wallets, transactions } = require("./db/schema");
const { eq } = require("drizzle-orm");
const TronWeb = require("tronweb").default;
const { users } = require("./db/schema");


const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || "Unknown";

  try {
    // Check if user already exists
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);

    if (!existingUser) {
      await db.insert(users).values({
        telegramUserId: chatId.toString(),
        telegramUsername: username,
      });
      bot.sendMessage(
        chatId,
        `✅ You have been registered for TRX transaction alerts!`
      );
    } else {
      bot.sendMessage(chatId, `⚡ You are already registered.`);
    }

    // Send welcome message
    bot.sendMessage(
      chatId,
      "Welcome! Use /setwallet to configure your wallet and /checkbalance to monitor funds.",
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error handling /start:", error);
    bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
  }
});

// Handle /setwallet command
bot.onText(/\/setwallet/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "Send wallet details in this format:\n\n`blockchain: TRX\nprivateKey: YOUR_PRIVATE_KEY\nreceiver: RECEIVER_ADDRESS\nthreshold: 1000000`",
    { parse_mode: "Markdown" }
  );
});

// Handle Wallet Data
bot.onText(
  /blockchain: (.+)\nprivateKey: (.+)\nreceiver: (.+)\nthreshold: (.+)/,
  async (msg, match) => {
    const chatId = msg.chat.id;
    const blockchain = match[1];
    const privateKey = match[2];
    const receiver = match[3];
    const threshold = parseInt(match[4]);

    if (!blockchain || !privateKey || !receiver || isNaN(threshold)) {
      return bot.sendMessage(chatId, "❌ Invalid format! Please try again.");
    }

    try {
      // First get the user's database ID
      const user = await db
        .select()
        .from(users)
        .where(eq(users.telegramUserId, chatId.toString()))
        .then((res) => res[0]);

      if (!user) {
        return bot.sendMessage(chatId, "❌ Please use /start command first to register.");
      }

      await db.insert(wallets).values({
        userId: user.id,
        blockchain,
        privateKey,
        address: "To be generated",
        threshold,
        receiverAddress: receiver,
      });

      bot.sendMessage(
        chatId,
        `✅ Wallet set up successfully! Blockchain: ${blockchain}`
      );
    } catch (error) {
      console.error("Error saving wallet:", error);
      bot.sendMessage(chatId, "❌ Error saving wallet. Try again later.");
    }
  }
);

// Command: /checkbalance
bot.onText(/\/checkbalance/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Fetch user first
    const user = await db
      .select()
      .from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);

    if (!user) {
      return bot.sendMessage(chatId, "❌ Please use /start first.");
    }

    // Fetch wallet using user.id
    const wallet = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, user.id))
      .then((res) => res[0]);

    if (!wallet) {
      return bot.sendMessage(chatId, "❌ No wallet found. Use /setwallet first!");
    }

    if (wallet.blockchain === "TRX") {
      const tronWeb = new TronWeb({
        fullHost: "https://api.trongrid.io",
        privateKey: wallet.privateKey
      });
      const balance = await tronWeb.trx.getBalance(wallet.address);
      bot.sendMessage(chatId, `💰 Your TRX balance: ${balance / 1e6} TRX`);
    } else {
      bot.sendMessage(chatId, "❌ Unsupported blockchain for now.");
    }
  } catch (error) {
    console.error("Error checking balance:", error);
    bot.sendMessage(chatId, "❌ Failed to check balance.");
  }
});


// Function to check and send TRX
async function checkAndSendTRX(wallet) {
  try {
    const tronWeb = new TronWeb({
      fullHost: "https://api.trongrid.io",
      privateKey: wallet.privateKey
    });

    const balance = await tronWeb.trx.getBalance(wallet.address);
    console.log(`💰 Balance for ${wallet.address}: ${balance / 1e6} TRX`);

    if (balance >= wallet.threshold) {
      const estimatedFee = 100000; // Approximate transaction fee
      const amountToSend = balance - estimatedFee;

      const transaction = await tronWeb.transactionBuilder.sendTrx(
        wallet.receiverAddress,
        amountToSend,
        wallet.address
      );

      const signedTransaction = await tronWeb.trx.sign(transaction);
      const response = await tronWeb.trx.sendRawTransaction(signedTransaction);

      if (response.result) {
        await db.insert(transactions).values({
          walletId: wallet.id,
          blockchain: "TRX",
          amount: amountToSend,
          status: "success",
          txHash: response.txid,
        });

        console.log(
          `✅ Sent ${amountToSend / 1e6} TRX to ${wallet.receiverAddress}`
        );

        // 📢 Send Telegram Notification
        const message = `🚀 *Transaction Alert!*\n\n✅ *${
          amountToSend / 1e6
        } TRX* sent to *${wallet.receiverAddress}*\n📌 *Tx Hash:* ${
          response.txid
        }\n\n🔗 [View on TRON Explorer](https://tronscan.org/#/transaction/${
          response.txid
        })`;
        bot.sendMessage(wallet.userId, message, {
          parse_mode: "Markdown",
        });
      } else {
        console.log("❌ Transaction failed.");
      }
    }
  } catch (error) {
    console.error("❌ Error checking balance or sending TRX:", error.message);
  }
}

// Periodic Balance Check (Runs Every 1 Minute)
setInterval(async () => {
  const userWallets = await db.select().from(wallets);
  for (const wallet of userWallets) {
    if (wallet.blockchain === "TRX") {
      await checkAndSendTRX(wallet);
    }
  }
}, 60000);

console.log("🔄 Neone Bot Activated");
