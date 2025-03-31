import dotenv from 'dotenv';
import { TronWeb } from 'tronweb';
import { createLogger, format, transports } from 'winston';
import 'winston-daily-rotate-file';

dotenv.config();

// Configure Winston logger
const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.DailyRotateFile({
      filename: "logs/error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      level: "error",
      maxFiles: "14d",
    }),
    new transports.DailyRotateFile({
      filename: "logs/combined-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
    }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
});

// Add at the top of your file after the logger configuration
process.on("uncaughtException", (error: Error) => {
  logger.error("Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  logger.error("Unhandled Rejection", {
    reason,
    promise,
  });
});

// TronWeb configuration
const tronWeb = new TronWeb({
  fullHost: "https://api.trongrid.io",
});

// Log startup configuration
logger.info("Starting TRON transaction bot");
logger.info(`Using TRON network: ${tronWeb.fullNode.host}`);

const senderPrivateKey: string = process.env.SENDER_PRIVATE_KEY || '';
const multiSigWalletAddress: string = process.env.MULTISIGWALLETADDRESS || '';
const receiverAddress: string = process.env.RECIEVER_ADDRESS || '';
const thresholdBalance: number = 820000;

tronWeb.setPrivateKey(senderPrivateKey);

logger.info("Configuration loaded", {
  multiSigWalletAddress,
  receiverAddress,
  thresholdBalance,
});

// Add after require statements
function validateEnvironment(): void {
  const required: string[] = [
    "SENDER_PRIVATE_KEY",
    "MULTISIGWALLETADDRESS",
    "RECIEVER_ADDRESS",
  ];

  const missing: string[] = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.error("Missing required environment variables", { missing });
    process.exit(1);
  }
}

// Call it before using any env vars
validateEnvironment();

async function checkBalanceAndSendTransaction(): Promise<void> {
  logger.info("Initiating balance check");
  try {
    const balance: number = await tronWeb.trx.getBalance(multiSigWalletAddress);
    logger.info("Balance retrieved", {
      balance,
      walletAddress: multiSigWalletAddress,
    });

    if (balance >= thresholdBalance) {
      logger.info("Balance exceeds threshold, initiating transfer", {
        balance,
        threshold: thresholdBalance,
      });
      await sendAllTRX(balance);
    } else {
      logger.info("Balance below threshold, no action needed", {
        balance,
        threshold: thresholdBalance,
      });
    }
  } catch (error) {
    logger.error("Failed to check balance", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

async function sendAllTRX(balance: number, retryCount: number = 0): Promise<void> {
  const MAX_RETRIES = 3;
  try {
    // Check permissions first
    const permissions = await checkWalletPermissions();
    if (!permissions) {
      throw new Error("Failed to verify wallet permissions");
    }

    const estimatedFee = 100000;
    const amountToSend = balance - estimatedFee;

    // Create unsigned transaction
    const transaction = await tronWeb.transactionBuilder.sendTrx(
      receiverAddress,
      amountToSend,
      multiSigWalletAddress
    );

    // Add permission id if required
    const signedTransaction = await tronWeb.trx.multiSign(
      transaction,
      senderPrivateKey,
      2 // Permission id - adjust based on your wallet's configuration
    );

    const response = await tronWeb.trx.sendRawTransaction(signedTransaction);
    // Rest of your existing code...
  } catch (error) {
    logger.error("Transaction failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

// Add before starting the interval
let intervalId: NodeJS.Timeout;

function gracefulShutdown(): void {
  logger.info("Received shutdown signal, cleaning up...");
  clearInterval(intervalId);
  logger.info("Cleanup completed, shutting down");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Modify the interval start
logger.info("Starting periodic balance checks");
intervalId = setInterval(checkBalanceAndSendTransaction, 60000);

// Initial check on startup
checkBalanceAndSendTransaction();

async function checkWalletPermissions(): Promise<any> {
  try {
    const contract = await tronWeb.trx.getContract(multiSigWalletAddress);
    logger.info("Contract permissions", {
      contract: contract,
      ownerAddress: tronWeb.defaultAddress.base58,
    });

    // Get active permissions
    const accountPermissions = await tronWeb.trx.getAccountResources(
      multiSigWalletAddress
    );
    logger.info("Account permissions", {
      permissions: accountPermissions,
    });

    return accountPermissions;
  } catch (error) {
    logger.error("Failed to check wallet permissions", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

async function validateWalletType(): Promise<boolean> {
  try {
    const account = await tronWeb.trx.getAccount(multiSigWalletAddress);
    if (!account.owner_permission || !account.active_permission) {
      throw new Error("Not a multi-signature wallet");
    }
    logger.info("Wallet validation successful", {
      permissions: {
        owner: account.owner_permission,
        active: account.active_permission,
      },
    });
    return true;
  } catch (error) {
    logger.error("Wallet validation failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
  }
}

async function initialize(): Promise<void> {
  const isValid = await validateWalletType();
  if (!isValid) {
    logger.error("Invalid wallet configuration, exiting");
    process.exit(1);
  }

  intervalId = setInterval(checkBalanceAndSendTransaction, 30000);
  checkBalanceAndSendTransaction();
}

initialize();
