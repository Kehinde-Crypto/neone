require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { db } = require("./db/db");
const { wallets, transactions, users } = require("./db/schema");
const { eq } = require("drizzle-orm");
const { TronWeb } = require("tronweb");
const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
const { ECPairFactory } = require("ecpair");
const bip39 = require("bip39");
const hdkey = require("hdkey");

const ECPair = ECPairFactory(ecc);

// Create bot instance
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Global userStates for interactive wallet setup
const userStates = new Map();

// List of supported BTC derivation paths
const supportedBTCPaths = [
  "m/44'/0'/0'/0/0",   // Legacy
  "m/49'/0'/0'/0/0",   // SegWit (P2SH)
  "m/84'/0'/0'/0/0",   // Native SegWit (bech32)
];

//
// UTIL: Derive BTC wallet from a seed phrase using multiple derivation paths
//
async function deriveBTCWallet(seedPhrase) {
  const normalizedSeed = seedPhrase.trim().replace(/\s+/g, " ").toLowerCase();

  if (!bip39.validateMnemonic(normalizedSeed)) {
    throw new Error("Invalid seed phrase. Please check your words and try again.");
  }

  const seed = await bip39.mnemonicToSeed(normalizedSeed);
  const root = hdkey.fromMasterSeed(seed);
  let derivedWallet = null;

  for (const path of supportedBTCPaths) {
    try {
      const child = root.derive(path);
      if (!child.privateKey) continue;

      // Use p2pkh as a first option (legacy) – you might try other payment schemes here
      const { address } = bitcoin.payments.p2pkh({
        pubkey: Buffer.from(child.publicKey),
        network: bitcoin.networks.bitcoin,
      });
      if (address) {
        derivedWallet = {
          address,
          privateKey: child.toWIF(),
          derivationPath: path,
        };
        console.log(`Wallet derived using path: ${path} => Address: ${address}`);
        break;
      }
    } catch (err) {
      console.error(`Error with derivation path ${path}:`, err);
      continue;
    }
  }
  if (!derivedWallet) {
    throw new Error("Unsupported wallet derivation path or unknown seed phrase type.");
  }
  return derivedWallet;
}

//
// TELEGRAM BOT COMMANDS & FLOW
//

// Set up the bot command menu
bot.setMyCommands([
  { command: "start", description: "Start the bot and get registered" },
  { command: "setwallet", description: "Add a new wallet for monitoring" },
  { command: "listwallets", description: "View all your configured wallets" },
  { command: "checkbalance", description: "Check your wallet balance" },
  { command: "deletewallet", description: "Delete a configured wallet" }
]);

// /start command – register user if necessary
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || "Unknown";
  try {
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
      bot.sendMessage(chatId, `✅ You have been registered for TRX transaction alerts!`);
    } else {
      bot.sendMessage(chatId, `⚡ You are already registered.`);
    }

    bot.sendMessage(
      chatId,
      "Welcome to the TRX Transaction Bot! 🚀\n\n" +
        "I'll help you monitor your crypto wallets and automatically transfer funds when they reach your specified threshold.\n\n" +
        "Use the menu button (/) to see all available commands, or click the button below:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [["/start", "/setwallet"], ["/listwallets", "/checkbalance"]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
  } catch (error) {
    console.error("Error handling /start:", error);
    bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
  }
});

// /listwallets command – show user’s saved wallets
bot.onText(/\/listwallets/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await db
      .select()
      .from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);
    if (!user) return bot.sendMessage(chatId, "❌ Please use /start first.");
    const userWallets = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, user.id));
    if (userWallets.length === 0)
      return bot.sendMessage(chatId, "❌ No wallets found. Use /setwallet to add a wallet!");
    let message = "📋 *Your Wallets:*\n\n";
    for (const wallet of userWallets) {
      message += `*Wallet ${wallet.id}*\n`;
      message += `Blockchain: ${wallet.blockchain}\n`;
      message += `Address: \`${wallet.address}\`\n`;
      message += `Receiver: \`${wallet.receiverAddress}\`\n\n`;
    }
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error listing wallets:", error);
    bot.sendMessage(chatId, "❌ Failed to list wallets.");
  }
});

// /setwallet command – interactive flow to add wallet
bot.onText(/\/setwallet/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { step: "blockchain", data: {} });
  bot.sendMessage(
    chatId,
    "Let's set up your wallet. First, please select the blockchain:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "TRX", callback_data: "blockchain_TRX" }],
          [{ text: "BTC", callback_data: "blockchain_BTC" }],
          [{ text: "ETH", callback_data: "blockchain_ETH" }],
          [{ text: "SOL", callback_data: "blockchain_SOL" }],
        ],
      },
    }
  );
});

// Callback query handler for wallet setup
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith("blockchain_")) {
    const blockchain = data.split("_")[1];
    userStates.set(chatId, { step: "auth_method", data: { blockchain } });
    await bot.editMessageText("How would you like to authenticate your wallet?", {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Private Key", callback_data: "auth_privateKey" }],
          [{ text: "Seed Phrase", callback_data: "auth_seedPhrase" }],
        ],
      },
    });
  } else if (data.startsWith("auth_")) {
    const authMethod = data.split("_")[1];
    const state = userStates.get(chatId);
    state.step = "key";
    state.data.authMethod = authMethod;
    userStates.set(chatId, state);
    let promptMessage;
    if (state.data.blockchain === "BTC") {
      promptMessage =
        authMethod === "privateKey"
          ? 'Please enter your BTC private key:\n\n• Must be 64 hexadecimal characters (0-9, a-f)\n• Do not include "0x" prefix\n• Example: 1234...abcd'
          : 'Please enter your 12 or 24-word seed phrase:\n\n• Words must be separated by single spaces\n• Example: word1 word2 word3 ... word12';
    } else {
      promptMessage =
        authMethod === "privateKey" ? "Please enter your private key:" : "Please enter your seed phrase:";
    }
    await bot.editMessageText(
      `${promptMessage}\n\n⚠️ This will be stored securely but please be careful when sharing sensitive information.`,
      { chat_id: chatId, message_id: callbackQuery.message.message_id }
    );
  }
});

// Continue the interactive wallet setup flow
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === "key") {
    state.data.key = msg.text;
    state.step = "receiver";
    userStates.set(chatId, state);
    bot.sendMessage(chatId, "Please enter the receiver address where funds should be sent.");
  } else if (state.step === "receiver") {
    state.data.receiver = msg.text;
    if (state.data.blockchain === "BTC") {
      try {
        // For BTC, we use seed phrase derivation (if selected) and set threshold to 0 (clear entire balance)
        await setupWallet(
          chatId,
          state.data.blockchain,
          state.data.key,
          state.data.receiver,
          0,
          state.data.authMethod === "privateKey" ? "privateKey" : "seedPhrase"
        );
        userStates.delete(chatId);
      } catch (error) {
        bot.sendMessage(chatId, `❌ ${error.message}`);
      }
    } else {
      state.step = "threshold";
      userStates.set(chatId, state);
      bot.sendMessage(chatId, "Please enter the threshold amount (minimum balance to trigger transfer):");
    }
  } else if (state.step === "threshold") {
    const threshold = parseFloat(msg.text);
    if (isNaN(threshold) || threshold <= 0)
      return bot.sendMessage(chatId, "❌ Please enter a valid positive number for threshold.");
    try {
      await setupWallet(
        chatId,
        state.data.blockchain,
        state.data.key,
        state.data.receiver,
        threshold,
        state.data.authMethod === "privateKey" ? "privateKey" : "seedPhrase"
      );
      userStates.delete(chatId);
    } catch (error) {
      bot.sendMessage(chatId, `❌ ${error.message}`);
    }
  }
});

// Function to set up a wallet
async function setupWallet(chatId, blockchain, key, receiver, threshold, keyType) {
  // Lookup the user by telegram id
  const user = await db
    .select()
    .from(users)
    .where(eq(users.telegramUserId, chatId.toString()))
    .then((res) => res[0]);
  if (!user) {
    return bot.sendMessage(chatId, "❌ Please use /start command first to register.");
  }

  let address;
  switch (blockchain) {
    case "TRX": {
      const tronWeb = new TronWeb({
        fullHost: "https://api.trongrid.io",
        ...(keyType === "privateKey" ? { privateKey: key } : {}),
      });
      address =
        keyType === "privateKey"
          ? tronWeb.address.fromPrivateKey(key)
          : (await tronWeb.createAccountWithMnemonic(key)).address.base58;
      break;
    }
    case "BTC":
      try {
        const network = bitcoin.networks.bitcoin;
        let keyPair;
        if (keyType === "privateKey") {
          // Validate private key format (hex string)
          const cleanKey = key.trim().toLowerCase().replace("0x", "");
          if (!/^[0-9a-f]{64}$/.test(cleanKey)) {
            throw new Error(
              "Invalid private key format.\n• Must be exactly 64 hexadecimal characters (0-9, a-f)\n• Do not include '0x' prefix\n• Example: 1234...abcd"
            );
          }
          try {
            keyPair = ECPair.fromPrivateKey(Buffer.from(cleanKey, "hex"), { network });
          } catch (e) {
            throw new Error("Invalid private key value. Please check your key and try again.");
          }
        } else {
          // Handle seed phrase: normalize input and attempt derivation using multiple paths
          const normalizedKey = key.trim().replace(/\s+/g, " ").toLowerCase();
          const words = normalizedKey.split(" ");
          console.log(`Seed phrase received, word count: ${words.length}`);
          console.log(`Normalized seed phrase: ${normalizedKey}`);
          if (words.length !== 12 && words.length !== 24) {
            throw new Error(
              "Invalid seed phrase length.\n• Must be exactly 12 or 24 words\n• Words must be separated by single spaces"
            );
          }
          if (!bip39.validateMnemonic(normalizedKey)) {
            console.error("Normalized seed phrase:", normalizedKey);
            throw new Error("Invalid seed phrase. Please check your words and try again.");
          }
          // Attempt multiple derivation paths
          let derived = null;
          const seed = bip39.mnemonicToSeedSync(normalizedKey);
          const root = hdkey.fromMasterSeed(seed);
          for (const path of supportedBTCPaths) {
            try {
              const child = root.derivePath(path);
              if (child.privateKey) {
                // Try legacy P2PKH address first:
                const { address: derivedAddress } = bitcoin.payments.p2pkh({
                  pubkey: Buffer.from(child.publicKey),
                  network,
                });
                if (derivedAddress) {
                  derived = {
                    keyPair: ECPair.fromPrivateKey(child.privateKey, { network }),
                    derivationPath: path,
                    address: derivedAddress,
                  };
                  console.log(`Derived BTC wallet via ${path}: ${derivedAddress}`);
                  break;
                }
              }
            } catch (err) {
              console.error(`Error deriving path ${path}:`, err);
              continue;
            }
          }
          if (!derived) {
            throw new Error("Unsupported wallet derivation path or unknown seed phrase type.");
          }
          keyPair = derived.keyPair;
        }
        // Now build a BTC address from the keyPair using P2PKH (you might also try P2WPKH or P2SH)
        const { address: btcAddress } = bitcoin.payments.p2pkh({
          pubkey: Buffer.from(keyPair.publicKey),
          network,
        });
        if (!btcAddress) throw new Error("Failed to generate BTC address");
        address = btcAddress;
        // Convert the key to WIF format for storage
        key = keyPair.toWIF();
      } catch (error) {
        console.error("BTC wallet creation error:", error);
        throw new Error("Failed to create BTC wallet: " + error.message);
      }
      break;
    case "ETH":
      address = "ETH_ADDRESS"; // Placeholder for Ethereum
      break;
    case "SOL":
      address = "SOL_ADDRESS"; // Placeholder for Solana
      break;
    default:
      throw new Error("Unsupported blockchain");
  }

  if (!address) {
    throw new Error("Failed to generate wallet address");
  }

  // Save wallet info in the database
  await db.insert(wallets).values({
    userId: user.id,
    blockchain,
    privateKey: key,
    address,
    threshold: threshold || 1,
    receiverAddress: receiver,
  });

  bot.sendMessage(
    chatId,
    `✅ Wallet set up successfully!\n\nBlockchain: ${blockchain}\nAddress: \`${address}\``,
    { parse_mode: "Markdown" }
  );
}

// /checkbalance command – show current balances
bot.onText(/\/checkbalance/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await db
      .select()
      .from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);
    if (!user) return bot.sendMessage(chatId, "❌ Please use /start first.");

    const userWallets = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, user.id));

    if (userWallets.length === 0)
      return bot.sendMessage(chatId, "❌ No wallets found. Use /setwallet to add a wallet!");

    let message = "💰 *Wallet Balances:*\n\n";

    for (const wallet of userWallets) {
      if (wallet.blockchain === "TRX") {
        const tronWeb = new TronWeb({
          fullHost: "https://api.trongrid.io",
          privateKey: wallet.privateKey,
        });
        const balance = await tronWeb.trx.getBalance(wallet.address);
        message += `*Wallet ${wallet.id}*\n`;
        message += `Address: \`${wallet.address}\`\n`;
        message += `Balance: ${balance / 1e6} TRX\n\n`;
      } else if (wallet.blockchain === "BTC") {
        try {
          const res = await fetch(`https://blockchain.info/unspent?active=${wallet.address}`);
          if (!res.ok) {
            message += `*Wallet ${wallet.id}*\nAddress: \`${wallet.address}\`\nBalance: 0 BTC (no UTXOs)\n\n`;
            continue;
          }
          const jsonData = await res.json();
          if (!jsonData.unspent_outputs || jsonData.unspent_outputs.length === 0) {
            message += `*Wallet ${wallet.id}*\nAddress: \`${wallet.address}\`\nBalance: 0 BTC (no UTXOs)\n\n`;
          } else {
            const balanceSats = jsonData.unspent_outputs.reduce((acc, utxo) => acc + utxo.value, 0);
            const balanceBtc = balanceSats / 1e8;
            message += `*Wallet ${wallet.id}*\n`;
            message += `Address: \`${wallet.address}\`\n`;
            message += `Balance: ${balanceBtc} BTC\n\n`;
          }
        } catch (error) {
          console.error("Error fetching BTC UTXOs:", error);
          message += `*Wallet ${wallet.id}*\nAddress: \`${wallet.address}\`\nBalance: Unknown (API error)\n\n`;
        }
      } else {
        message += `*Wallet ${wallet.id}*\n`;
        message += `Blockchain: ${wallet.blockchain}\nStatus: Unsupported blockchain\n\n`;
      }
    }

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error checking balance:", error);
    bot.sendMessage(chatId, "❌ Failed to check balance.");
  }
});

// Function to check and send funds (sweeping) for TRX and BTC wallets
async function checkAndSendTRX(wallet) {
  try {
    let balance = 0;
    let amountToSend = 0;
    let response;

    switch (wallet.blockchain) {
      case "TRX": {
        const tronWeb = new TronWeb({
          fullHost: "https://api.trongrid.io",
          privateKey: wallet.privateKey,
        });
        balance = await tronWeb.trx.getBalance(wallet.address);
        if (balance > 0) {
          const estimatedFee = 100000;
          amountToSend = balance - estimatedFee;
          if (amountToSend <= 0) return;

          const transaction = await tronWeb.transactionBuilder.sendTrx(
            wallet.receiverAddress,
            amountToSend,
            wallet.address
          );
          const signedTransaction = await tronWeb.trx.sign(transaction);
          response = await tronWeb.trx.sendRawTransaction(signedTransaction);
        }
        break;
      }

      case "BTC":
        try {
          const network = bitcoin.networks.bitcoin;
          // Reconstruct keyPair from WIF directly
          const keyPair = ECPair.fromWIF(wallet.privateKey, network);

          const utxoResponse = await fetch(`https://blockchain.info/unspent?active=${wallet.address}`);
          const utxoData = await utxoResponse.json();

          if (utxoData.unspent_outputs && utxoData.unspent_outputs.length > 0) {
            const utxos = utxoData.unspent_outputs;
            balance = utxos.reduce((acc, utxo) => acc + utxo.value, 0);
            if (balance > 0) {
              const feeRate = 10; // satoshis/byte
              const estimatedSize = 180;
              const fee = estimatedSize * feeRate;
              amountToSend = balance - fee;
              if (amountToSend <= 0) return;

              const psbt = new bitcoin.Psbt({ network });
              utxos.forEach((utxo) => {
                psbt.addInput({
                  hash: utxo.tx_hash_big_endian,
                  index: utxo.tx_output_n,
                  nonWitnessUtxo: Buffer.from(utxo.script, "hex"),
                });
              });
              psbt.addOutput({
                address: wallet.receiverAddress,
                value: amountToSend,
              });
              utxos.forEach((_, i) => {
                psbt.signInput(i, keyPair);
                psbt.validateSignaturesOfInput(i);
              });
              psbt.finalizeAllInputs();
              const tx = psbt.extractTransaction();
              const txHex = tx.toHex();
              const broadcastResponse = await fetch("https://blockchain.info/pushtx", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `tx=${txHex}`,
              });
              if (broadcastResponse.ok) {
                response = { result: true, txid: tx.getId() };
              }
            }
          }
        } catch (error) {
          console.error("Error processing BTC transaction:", error);
        }
        break;
      // ETH and SOL placeholders could be added similarly
    }

    if (response && response.result) {
      await db.insert(transactions).values({
        walletId: wallet.id,
        blockchain: wallet.blockchain,
        amount: amountToSend,
        status: "success",
        txHash: response.txid,
      });

      const user = await db
        .select()
        .from(users)
        .where(eq(users.id, wallet.userId))
        .then((res) => res[0]);
      if (user) {
        const message = `🚀 *Transaction Alert!*\n\n✅ *${
          wallet.blockchain === "BTC" ? amountToSend / 1e8 : amountToSend / 1e6
        } ${wallet.blockchain}* sent to *${wallet.receiverAddress}*\n📌 *Tx Hash:* ${
          response.txid
        }\n\n🔗 [View on Explorer](${
          wallet.blockchain === "BTC"
            ? `https://blockchain.com/btc/tx/${response.txid}`
            : `https://tronscan.org/#/transaction/${response.txid}`
        })`;
        bot.sendMessage(user.telegramUserId, message, { parse_mode: "Markdown" });
      }
    }
  } catch (error) {
    console.error(`❌ Error processing ${wallet.blockchain} transaction:`, error.message);
  }
}

// Periodic check for TRX and BTC wallets every 60 seconds
setInterval(async () => {
  const userWallets = await db.select().from(wallets);
  for (const wallet of userWallets) {
    if (wallet.blockchain === "TRX" || wallet.blockchain === "BTC") {
      await checkAndSendTRX(wallet);
    }
  }
}, 60000);

// /deletewallet command – remove wallet and associated transactions
bot.onText(/\/deletewallet/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await db
      .select()
      .from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);
    if (!user) return bot.sendMessage(chatId, "❌ Please use /start first.");
    const userWallets = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, user.id));
    if (userWallets.length === 0)
      return bot.sendMessage(chatId, "❌ No wallets found. Use /setwallet to add a wallet!");
    const keyboard = userWallets.map((wallet) => [
      {
        text: `Wallet ${wallet.id} (${wallet.address.slice(0, 8)}...)`,
        callback_data: `delete_wallet_${wallet.id}`,
      },
    ]);
    bot.sendMessage(chatId, "Select the wallet you want to delete:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (error) {
    console.error("Error listing wallets for deletion:", error);
    bot.sendMessage(chatId, "❌ Failed to list wallets.");
  }
});

// Handle deletion callback queries
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  if (data.startsWith("delete_wallet_")) {
    const walletId = parseInt(data.split("_")[2]);
    try {
      await db.delete(transactions).where(eq(transactions.walletId, walletId));
      await db.delete(wallets).where(eq(wallets.id, walletId));
      await bot.editMessageText("✅ Wallet deleted successfully!", {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      bot.sendMessage(chatId, "The wallet has been removed from monitoring. Use /listwallets to see your remaining wallets.");
    } catch (error) {
      console.error("Error deleting wallet:", error);
      await bot.editMessageText("❌ Failed to delete wallet. Please try again.", {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    }
  }
});

console.log("🔄 Neone Bot Activated");
