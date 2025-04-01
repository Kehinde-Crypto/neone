require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { db } = require("./db/db");
const { wallets, transactions } = require("./db/schema");
const { eq } = require("drizzle-orm");
const { TronWeb } = require("tronweb");
const { users } = require("./db/schema");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Set up command menu
bot.setMyCommands([
  {
    command: "start",
    description: "Start the bot and get registered"
  },
  {
    command: "setwallet",
    description: "Add a new wallet for monitoring"
  },
  {
    command: "listwallets",
    description: "View all your configured wallets"
  },
  {
    command: "checkbalance",
    description: "Check your wallet balance"
  },
  {
    command: "deletewallet",
    description: "Delete a configured wallet"
  }
]);

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

    // Send welcome message with menu button
    bot.sendMessage(
      chatId,
      "Welcome to the TRX Transaction Bot! 🚀\n\n" +
      "I'll help you monitor your TRX wallets and automatically transfer funds when they reach your specified threshold.\n\n" +
      "Use the menu button (/) to see all available commands, or click the button below:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [["/start", "/setwallet"], ["/listwallets", "/checkbalance"]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  } catch (error) {
    console.error("Error handling /start:", error);
    bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
  }
});

// Handle /listwallets command
bot.onText(/\/listwallets/, async (msg) => {
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

    // Fetch all wallets for the user
    const userWallets = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, user.id));

    if (userWallets.length === 0) {
      return bot.sendMessage(
        chatId,
        "❌ No wallets found. Use /setwallet to add a wallet!"
      );
    }

    // Create a formatted message with wallet details
    let message = "📋 *Your Wallets:*\n\n";
    for (const wallet of userWallets) {
      message += `*Wallet ${wallet.id}*\n`;
      message += `Blockchain: ${wallet.blockchain}\n`;
      message += `Address: \`${wallet.address}\`\n`;
      message += `Receiver: \`${wallet.receiverAddress}\`\n`;
      message += `Threshold: ${wallet.threshold / 1e6} TRX\n\n`;
    }

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error listing wallets:", error);
    bot.sendMessage(chatId, "❌ Failed to list wallets.");
  }
});

// Handle /setwallet command
bot.onText(/\/setwallet/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "Send wallet details in this format:\n\n`blockchain: TRX\nprivateKey: YOUR_PRIVATE_KEY\nreceiver: RECEIVER_ADDRESS\nthreshold: 1000000`\n\nYou can add multiple wallets by using this command multiple times.",
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
        return bot.sendMessage(
          chatId,
          "❌ Please use /start command first to register."
        );
      }

      // Initialize TronWeb to generate address
      const tronWeb = new TronWeb({
        fullHost: "https://api.trongrid.io",
        privateKey: privateKey
      });

      // Get the address from the private key
      const address = tronWeb.address.fromPrivateKey(privateKey);

      console.log("Wallet Data:", {
        blockchain,
        privateKey,
        receiver,
        threshold,
        address
      });

      await db.insert(wallets).values({
        userId: user.id,
        blockchain,
        privateKey,
        address: address,
        threshold,
        receiverAddress: receiver,
      });

      bot.sendMessage(
        chatId,
        `✅ Wallet set up successfully!\n\nBlockchain: ${blockchain}\nAddress: \`${address}\``,
        { parse_mode: "Markdown" }
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
      return bot.sendMessage(
        chatId,
        "❌ No wallet found. Use /setwallet first!"
      );
    }

    if (wallet.blockchain === "TRX") {
      const tronWeb = new TronWeb({
        fullHost: "https://api.trongrid.io",
        privateKey: wallet.privateKey,
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
      privateKey: wallet.privateKey,
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

        // Get the user's Telegram chat ID
        const user = await db
          .select()
          .from(users)
          .where(eq(users.id, wallet.userId))
          .then((res) => res[0]);

        if (user) {
          // 📢 Send Telegram Notification
          const message = `🚀 *Transaction Alert!*\n\n✅ *${
            amountToSend / 1e6
          } TRX* sent to *${wallet.receiverAddress}*\n📌 *Tx Hash:* ${
            response.txid
          }\n\n🔗 [View on TRON Explorer](https://tronscan.org/#/transaction/${
            response.txid
          })`;
          bot.sendMessage(user.telegramUserId, message, {
            parse_mode: "Markdown",
          });
        }
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

// Handle /deletewallet command
bot.onText(/\/deletewallet/, async (msg) => {
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

    // Fetch all wallets for the user
    const userWallets = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, user.id));

    if (userWallets.length === 0) {
      return bot.sendMessage(
        chatId,
        "❌ No wallets found. Use /setwallet to add a wallet!"
      );
    }

    // Create inline keyboard with wallet options
    const keyboard = userWallets.map(wallet => [{
      text: `Wallet ${wallet.id} (${wallet.address.slice(0, 8)}...)`,
      callback_data: `delete_wallet_${wallet.id}`
    }]);

    bot.sendMessage(
      chatId,
      "Select the wallet you want to delete:",
      {
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    );
  } catch (error) {
    console.error("Error listing wallets for deletion:", error);
    bot.sendMessage(chatId, "❌ Failed to list wallets.");
  }
});

// Handle callback queries (for wallet deletion)
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith("delete_wallet_")) {
    const walletId = parseInt(data.split("_")[2]);

    try {
      // Delete the wallet
      await db.delete(wallets).where(eq(wallets.id, walletId));

      // Update the message to show success
      await bot.editMessageText(
        "✅ Wallet deleted successfully!",
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          reply_markup: {
            inline_keyboard: []
          }
        }
      );

      // Send a confirmation message
      bot.sendMessage(
        chatId,
        "The wallet has been removed from monitoring. Use /listwallets to see your remaining wallets."
      );
    } catch (error) {
      console.error("Error deleting wallet:", error);
      await bot.editMessageText(
        "❌ Failed to delete wallet. Please try again.",
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          reply_markup: {
            inline_keyboard: []
          }
        }
      );
    }
  }
});

console.log("🔄 Neone Bot Activated");
